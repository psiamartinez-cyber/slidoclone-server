const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);

// ── CORS: permite tu dominio de Netlify y localhost ──
const io = new Server(server, {
  cors: {
    origin: '*',   // en producción cambia por tu URL de Netlify
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════
//  BASE DE DATOS EN MEMORIA
//  Para >500 usuarios o persistencia, migra a Redis/PostgreSQL
// ════════════════════════════════════════════════════
const DB = {
  sessions:      {},  // { [code]: sessionObj }
  questions:     {},  // { [id]: questionObj  }
  polls:         {},  // { [id]: pollObj      }
  pollResponses: {},  // { [pollId]: []       }
  votes:         {},  // { [questionId]: Set  }
};

// ════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════
function genCode() {
  const words = ['REUNION','CLASE','TALLER','EVENTO','CONGRESO','FORO','SESION','EQUIPO'];
  return '#' + words[Math.floor(Math.random()*words.length)] + (Math.floor(Math.random()*9000)+1000);
}

function genId(prefix='id') {
  return prefix + '_' + Date.now() + Math.random().toString(36).substr(2,5);
}

function sessionExists(code) {
  return !!DB.sessions[code];
}

// Limpia sesiones de más de 12 horas para no acumular memoria
setInterval(() => {
  const limit = Date.now() - 12*60*60*1000;
  Object.keys(DB.sessions).forEach(code => {
    if(DB.sessions[code].createdAt < limit) {
      delete DB.sessions[code];
      Object.keys(DB.questions).forEach(k => { if(DB.questions[k]?.sessionCode===code) delete DB.questions[k]; });
      Object.keys(DB.polls).forEach(k => { if(DB.polls[k]?.sessionCode===code){ delete DB.polls[k]; delete DB.pollResponses[k]; } });
    }
  });
}, 60*60*1000);

// ════════════════════════════════════════════════════
//  REST API  (usada solo para login y crear sesión)
// ════════════════════════════════════════════════════

// Health check – Railway lo usa para saber que el servicio vive
app.get('/', (req, res) => res.json({ status: 'ok', sessions: Object.keys(DB.sessions).length }));

// Login de administrador  (credenciales hardcodeadas para MVP)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if(email === 'admin@slido.co' && password === 'admin123') {
    const code = genCode();
    DB.sessions[code] = {
      code,
      adminEmail: email,
      createdAt:  Date.now(),
      participantCount: 0,
      settings: { moderation: true, anonymous: true }
    };
    return res.json({ ok: true, code });
  }
  res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
});

// Validar código de evento (participante)
app.get('/api/session/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  if(sessionExists(code)) {
    const s = DB.sessions[code];
    res.json({ ok: true, code, settings: s.settings });
  } else {
    res.status(404).json({ ok: false, error: 'Código de evento no encontrado' });
  }
});

// ════════════════════════════════════════════════════
//  SOCKET.IO — comunicación en tiempo real
// ════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[+] Conexión: ${socket.id}`);

  // ── JOIN SESSION ──────────────────────────────────
  socket.on('join_session', ({ code, role, participantId }) => {
    const c = code.toUpperCase();
    if(!sessionExists(c)) {
      socket.emit('error', { message: 'Sesión no encontrada' });
      return;
    }
    socket.join(c);
    socket.sessionCode = c;
    socket.role = role;  // 'admin' | 'participant'
    socket.participantId = participantId;

    if(role === 'participant') {
      DB.sessions[c].participantCount = (DB.sessions[c].participantCount || 0) + 1;
      io.to(c).emit('participant_count', { count: DB.sessions[c].participantCount });
    }

    // Enviar estado actual al que se acaba de unir
    const sessionQs    = Object.values(DB.questions).filter(q => q.sessionCode === c);
    const sessionPolls = Object.values(DB.polls).filter(p => p.sessionCode === c);
    const responsesMap = {};
    sessionPolls.forEach(p => { responsesMap[p.id] = DB.pollResponses[p.id] || []; });
    const votesMap = {};
    Object.keys(DB.votes).forEach(qId => {
      if(DB.questions[qId]?.sessionCode === c) votesMap[qId] = DB.votes[qId].size;
    });

    socket.emit('session_state', {
      session:    DB.sessions[c],
      questions:  sessionQs,
      polls:      sessionPolls,
      responses:  responsesMap,
      votes:      votesMap,
    });

    console.log(`[JOIN] ${role} ${socket.id} → ${c}`);
  });

  // ── PREGUNTAS ─────────────────────────────────────
  socket.on('submit_question', ({ text, author }) => {
    const code = socket.sessionCode;
    if(!code || !sessionExists(code)) return;
    const settings = DB.sessions[code].settings;
    const q = {
      id:          genId('q'),
      text:        text.trim().slice(0, 300),
      author:      author || 'Anónimo',
      status:      settings.moderation ? 'pending' : 'approved',
      highlighted: false,
      archived:    false,
      votes:       0,
      sessionCode: code,
      ts:          Date.now(),
    };
    DB.questions[q.id] = q;
    DB.votes[q.id] = new Set();
    // Al admin llega siempre; a participantes solo si está aprobada
    io.to(code).emit('question_add', { question: q });
    console.log(`[Q] ${q.author}: "${q.text.slice(0,40)}..." → ${q.status}`);
  });

  socket.on('moderate_question', ({ questionId, action }) => {
    if(socket.role !== 'admin') return;
    const q = DB.questions[questionId];
    if(!q || q.sessionCode !== socket.sessionCode) return;
    if(action === 'delete')      { delete DB.questions[questionId]; io.to(socket.sessionCode).emit('question_delete', { questionId }); return; }
    if(action === 'approve')     q.status = 'approved';
    if(action === 'highlight')   q.highlighted = true;
    if(action === 'unhighlight') q.highlighted = false;
    if(action === 'archive')     q.archived = true;
    io.to(socket.sessionCode).emit('question_update', { question: q });
  });

  socket.on('vote_question', ({ questionId }) => {
    const code = socket.sessionCode;
    if(!code || !DB.votes[questionId]) return;
    if(DB.votes[questionId].has(socket.participantId)) return; // ya votó
    DB.votes[questionId].add(socket.participantId);
    DB.questions[questionId].votes = DB.votes[questionId].size;
    io.to(code).emit('question_update', { question: DB.questions[questionId] });
  });

  // ── ENCUESTAS ─────────────────────────────────────
  socket.on('create_poll', ({ question, type, options, ratingMax }) => {
    if(socket.role !== 'admin') return;
    const code = socket.sessionCode;
    const poll = {
      id:       genId('poll'),
      question: question.trim().slice(0, 200),
      type,
      options:  options || [],
      ratingMax: ratingMax || 5,
      active:   false,
      sessionCode: code,
      ts:       Date.now(),
    };
    DB.polls[poll.id] = poll;
    DB.pollResponses[poll.id] = [];
    io.to(code).emit('poll_add', { poll });
  });

  socket.on('toggle_poll', ({ pollId }) => {
    if(socket.role !== 'admin') return;
    const code = socket.sessionCode;
    // Desactivar todas primero
    Object.values(DB.polls).filter(p => p.sessionCode===code && p.active).forEach(p => {
      p.active = false;
      io.to(code).emit('poll_update', { poll: p });
    });
    const poll = DB.polls[pollId];
    if(!poll || poll.sessionCode !== code) return;
    poll.active = !poll.active;
    io.to(code).emit('poll_update', { poll });
  });

  socket.on('delete_poll', ({ pollId }) => {
    if(socket.role !== 'admin') return;
    delete DB.polls[pollId];
    delete DB.pollResponses[pollId];
    io.to(socket.sessionCode).emit('poll_delete', { pollId });
  });

  socket.on('poll_respond', ({ pollId, value }) => {
    const code = socket.sessionCode;
    if(!DB.pollResponses[pollId]) DB.pollResponses[pollId] = [];
    // Evitar doble respuesta del mismo participante
    const already = DB.pollResponses[pollId].some(r => r.participantId === socket.participantId);
    if(already) { socket.emit('error', { message: 'Ya respondiste esta encuesta' }); return; }
    const response = { participantId: socket.participantId, value, ts: Date.now() };
    DB.pollResponses[pollId].push(response);
    io.to(code).emit('poll_response', { pollId, responses: DB.pollResponses[pollId] });
  });

  // ── SETTINGS ──────────────────────────────────────
  socket.on('update_settings', ({ settings }) => {
    if(socket.role !== 'admin') return;
    DB.sessions[socket.sessionCode].settings = settings;
    io.to(socket.sessionCode).emit('settings_update', { settings });
  });

  socket.on('reset_session', () => {
    if(socket.role !== 'admin') return;
    const code = socket.sessionCode;
    Object.keys(DB.questions).forEach(k => { if(DB.questions[k]?.sessionCode===code) delete DB.questions[k]; });
    Object.keys(DB.polls).forEach(k => { if(DB.polls[k]?.sessionCode===code){ delete DB.polls[k]; delete DB.pollResponses[k]; } });
    Object.keys(DB.votes).forEach(k => { if(DB.questions[k]?.sessionCode===code) delete DB.votes[k]; });
    DB.sessions[code].participantCount = 0;
    io.to(code).emit('session_reset');
  });

  // ── DISCONNECT ────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.sessionCode;
    if(code && sessionExists(code) && socket.role === 'participant') {
      DB.sessions[code].participantCount = Math.max(0, (DB.sessions[code].participantCount||1) - 1);
      io.to(code).emit('participant_count', { count: DB.sessions[code].participantCount });
    }
    console.log(`[-] Desconexión: ${socket.id}`);
  });
});

// ════════════════════════════════════════════════════
//  ARRANQUE
// ════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ SlidoClone server corriendo en puerto ${PORT}`);
  console.log(`   Admin: admin@slido.co / admin123`);
});

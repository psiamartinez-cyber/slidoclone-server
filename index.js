const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ════════════════════════════════════════════════════════════
const EVENT_CODE     = '#FORO2026';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@slido.co';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK || null;

// ════════════════════════════════════════════════════════════
//  BASE DE DATOS EN MEMORIA
// ════════════════════════════════════════════════════════════
const DB = {
  session: {
    code: EVENT_CODE,
    participantCount: 0,
    settings: { moderation: true, anonymous: true, qaEnabled: false }
  },
  questions:     {},
  polls:         {},
  pollResponses: {},
  votes:         {},  // { questionId: Set<participantId> }
};

// ════════════════════════════════════════════════════════════
//  GOOGLE SHEETS — escritura
// ════════════════════════════════════════════════════════════
async function saveToSheets(type, data) {
  if(!SHEETS_WEBHOOK) return;
  try {
    await fetch(SHEETS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data, ts: new Date().toISOString() })
    });
  } catch(e) { console.warn('[Sheets] Error escritura:', e.message); }
}

// ════════════════════════════════════════════════════════════
//  GOOGLE SHEETS — lectura al arrancar
// ════════════════════════════════════════════════════════════
async function loadFromSheets() {
  if(!SHEETS_WEBHOOK) {
    console.log('[Sheets] Sin webhook — arrancando con memoria vacía');
    return;
  }
  try {
    console.log('[Sheets] Cargando estado previo...');
    const url = SHEETS_WEBHOOK + '?action=load';
    const res  = await fetch(url);
    const data = await res.json();

    if(!data.ok) {
      console.warn('[Sheets] Error al cargar:', data.error);
      return;
    }

    // Cargar encuestas
    let pollCount = 0;
    (data.polls || []).forEach(poll => {
      DB.polls[poll.id] = poll;
      if(!DB.pollResponses[poll.id]) DB.pollResponses[poll.id] = [];
      pollCount++;
    });

    // Cargar respuestas de encuestas
    Object.entries(data.responses || {}).forEach(([pollId, responses]) => {
      DB.pollResponses[pollId] = responses;
    });

    // Cargar preguntas y sus votos
    let qCount = 0;
    (data.questions || []).forEach(q => {
      DB.questions[q.id] = q;
      DB.votes[q.id]     = new Set(); // los votos individuales no se restauran (privacidad)
      qCount++;
    });

    console.log(`[Sheets] Cargado: ${pollCount} encuestas, ${qCount} preguntas`);
  } catch(e) {
    console.warn('[Sheets] Error al cargar estado:', e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════
function genId(prefix='id') {
  return prefix + '_' + Date.now() + Math.random().toString(36).substr(2,5);
}

// ════════════════════════════════════════════════════════════
//  REST API
// ════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({
  status: 'ok', event: EVENT_CODE,
  participants: DB.session.participantCount,
  questions: Object.keys(DB.questions).length,
  polls: Object.keys(DB.polls).length,
  sheetsConnected: !!SHEETS_WEBHOOK
}));

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if(email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    return res.json({ ok: true, code: EVENT_CODE });
  }
  res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
});

app.get('/api/session/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  if(code === EVENT_CODE) {
    res.json({ ok: true, code: EVENT_CODE, settings: DB.session.settings });
  } else {
    res.status(404).json({ ok: false, error: 'Código no encontrado' });
  }
});

app.get('/api/export/:code', (req, res) => {
  if(req.params.code.toUpperCase() !== EVENT_CODE) return res.status(404).json({ ok: false });
  res.json({
    ok: true, event: EVENT_CODE,
    exportedAt: new Date().toISOString(),
    participants: DB.session.participantCount,
    questions: Object.values(DB.questions),
    polls: Object.values(DB.polls).map(p => ({ ...p, responses: DB.pollResponses[p.id]||[] }))
  });
});

// ════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('join_session', ({ code, role, participantId }) => {
    if(code.toUpperCase() !== EVENT_CODE) {
      socket.emit('error', { message: 'Código de evento no válido' });
      return;
    }
    socket.join(EVENT_CODE);
    socket.sessionCode   = EVENT_CODE;
    socket.role          = role;
    socket.participantId = participantId;

    if(role === 'participant') {
      DB.session.participantCount++;
      io.to(EVENT_CODE).emit('participant_count', { count: DB.session.participantCount });
    }

    // Enviar estado completo al nuevo participante/admin
    const votesMap = {};
    Object.keys(DB.votes).forEach(qId => { votesMap[qId] = DB.votes[qId].size; });

    socket.emit('session_state', {
      session:   { ...DB.session, participantCount: DB.session.participantCount },
      questions: Object.values(DB.questions),
      polls:     Object.values(DB.polls),
      responses: DB.pollResponses,
      votes:     votesMap,
    });
  });

  // ── PREGUNTAS ──────────────────────────────────────────
  socket.on('submit_question', ({ text, author }) => {
    if(!socket.sessionCode) return;
    const q = {
      id:          genId('q'),
      text:        text.trim().slice(0,300),
      author:      (author||'Anónimo').slice(0,50),
      status:      DB.session.settings.moderation ? 'pending' : 'approved',
      highlighted: false, archived: false,
      votes:       0, sessionCode: EVENT_CODE,
      ts:          Date.now(),
    };
    DB.questions[q.id] = q;
    DB.votes[q.id]     = new Set();
    io.to(EVENT_CODE).emit('question_add', { question: q });
    saveToSheets('question', { id: q.id, text: q.text, author: q.author, status: q.status });
  });

  socket.on('moderate_question', ({ questionId, action }) => {
    if(socket.role !== 'admin') return;
    const q = DB.questions[questionId];
    if(!q) return;
    if(action === 'delete') {
      delete DB.questions[questionId];
      io.to(EVENT_CODE).emit('question_delete', { questionId });
      saveToSheets('question_update', { id: questionId, status: 'eliminada' });
      return;
    }
    if(action === 'approve')     { q.status = 'approved'; saveToSheets('question_update', { id: q.id, status: 'approved' }); }
    if(action === 'highlight')   q.highlighted = true;
    if(action === 'unhighlight') q.highlighted = false;
    if(action === 'archive')     { q.archived = true; saveToSheets('question_update', { id: q.id, archived: true }); }
    io.to(EVENT_CODE).emit('question_update', { question: q });
  });

  socket.on('vote_question', ({ questionId }) => {
    if(!DB.votes[questionId]) DB.votes[questionId] = new Set();
    if(DB.votes[questionId].has(socket.participantId)) return;
    DB.votes[questionId].add(socket.participantId);
    DB.questions[questionId].votes = DB.votes[questionId].size;
    io.to(EVENT_CODE).emit('question_update', { question: DB.questions[questionId] });
    // Guardar conteo de votos actualizado
    saveToSheets('question_vote', { questionId, votes: DB.questions[questionId].votes });
  });

  // ── ENCUESTAS ──────────────────────────────────────────
  socket.on('create_poll', ({ question, type, options, ratingMax, imageUrl }) => {
    if(socket.role !== 'admin') return;
    const poll = {
      id:       genId('poll'),
      question: question.trim().slice(0,200),
      type, options: options||[], ratingMax: ratingMax||5,
      imageUrl: imageUrl||'',
      active:   false, sessionCode: EVENT_CODE, ts: Date.now(),
    };
    DB.polls[poll.id]         = poll;
    DB.pollResponses[poll.id] = [];
    io.to(EVENT_CODE).emit('poll_add', { poll });
    saveToSheets('poll_create', { id: poll.id, question: poll.question, type: poll.type, options: poll.options, ratingMax: poll.ratingMax, imageUrl: poll.imageUrl });
  });

  socket.on('toggle_poll', ({ pollId }) => {
    if(socket.role !== 'admin') return;
    // Desactivar todas primero
    Object.values(DB.polls).filter(p=>p.active).forEach(p => {
      p.active = false;
      io.to(EVENT_CODE).emit('poll_update', { poll: p });
    });
    const poll = DB.polls[pollId];
    if(!poll) return;
    poll.active = !poll.active;
    io.to(EVENT_CODE).emit('poll_update', { poll });
  });

  socket.on('delete_poll', ({ pollId }) => {
    if(socket.role !== 'admin') return;
    delete DB.polls[pollId];
    delete DB.pollResponses[pollId];
    io.to(EVENT_CODE).emit('poll_delete', { pollId });
    saveToSheets('poll_delete', { pollId });
  });

  socket.on('poll_respond', ({ pollId, value }) => {
    if(!DB.pollResponses[pollId]) DB.pollResponses[pollId] = [];
    const already = DB.pollResponses[pollId].some(r => r.participantId === socket.participantId);
    if(already) { socket.emit('error', { message: 'Ya respondiste esta encuesta' }); return; }
    const response = { participantId: socket.participantId, value, ts: Date.now() };
    DB.pollResponses[pollId].push(response);
    io.to(EVENT_CODE).emit('poll_response', { pollId, responses: DB.pollResponses[pollId] });
    saveToSheets('poll_response', { pollId, value, participantId: socket.participantId, ts: response.ts });
  });

  // ── SETTINGS ───────────────────────────────────────────
  socket.on('update_settings', ({ settings }) => {
    if(socket.role !== 'admin') return;
    DB.session.settings = settings;
    io.to(EVENT_CODE).emit('settings_update', { settings });
  });

  // ── RESET ──────────────────────────────────────────────
  socket.on('reset_questions', () => {
    if(socket.role !== 'admin') return;
    DB.questions = {};
    DB.votes     = {};
    io.to(EVENT_CODE).emit('questions_reset');
    saveToSheets('questions_reset', {});
    console.log('[RESET] Preguntas eliminadas');
  });

  socket.on('reset_session', () => {
    if(socket.role !== 'admin') return;
    DB.questions = {}; DB.polls = {}; DB.pollResponses = {}; DB.votes = {};
    DB.session.participantCount = 0;
    io.to(EVENT_CODE).emit('session_reset');
    saveToSheets('session_reset', {});
    console.log('[RESET] Sesión reiniciada');
  });

  // ── DISCONNECT ─────────────────────────────────────────
  socket.on('disconnect', () => {
    if(socket.role === 'participant') {
      DB.session.participantCount = Math.max(0, DB.session.participantCount - 1);
      io.to(EVENT_CODE).emit('participant_count', { count: DB.session.participantCount });
    }
    console.log(`[-] ${socket.id}`);
  });
});

// ════════════════════════════════════════════════════════════
//  ARRANQUE — primero carga Sheets, luego escucha
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;

loadFromSheets().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ SlidoClone #FORO2026 en puerto ${PORT}`);
    console.log(`   Sheets: ${SHEETS_WEBHOOK ? 'conectado' : 'deshabilitado'}`);
    console.log(`   Estado: ${Object.keys(DB.polls).length} encuestas, ${Object.keys(DB.questions).length} preguntas`);
  });
});

/* SMART STOCK - servidor + leitor RFID em um único processo.
   Uso: npm start   (ou: node server.js) */
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { SerialPort } = require('serialport');

const PORTA_HTTP = Number(process.env.PORT || 3000);
const PORTA_SERIAL = process.env.RFID_PORTA || '';   // vazio = detecta automaticamente
const BAUD_RATE = 115200;
const DB_PATH = path.join(__dirname, 'smartstock.db');

/* ================= BANCO DE DADOS ================= */
const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('ERRO AO ABRIR O BANCO:', err.message); process.exit(1); }
});
db.configure('busyTimeout', 5000);

const run = (sql, p = []) => new Promise((ok, no) => db.run(sql, p, function (e) { e ? no(e) : ok({ id: this.lastID, changes: this.changes }); }));
const all = (sql, p = []) => new Promise((ok, no) => db.all(sql, p, (e, r) => e ? no(e) : ok(r)));
const get = (sql, p = []) => new Promise((ok, no) => db.get(sql, p, (e, r) => e ? no(e) : ok(r)));

const clean = v => typeof v === 'string' ? v.trim() : '';
const validId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const soHex = v => String(v || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
const formatarUid = hex => hex.match(/.{2}/g)?.join(' ') || hex;
const uidValido = hex => [8, 14, 20].includes(hex.length);
const livre = s => String(s || '').trim().toLocaleLowerCase('pt-BR') === 'disponível';
const unico = e => /UNIQUE/i.test(e.message);

let usuarioAtivo = null;

async function iniciarBanco() {
  await run('PRAGMA foreign_keys = ON');
  await run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, matricula TEXT NOT NULL UNIQUE)`);
  await run(`CREATE TABLE IF NOT EXISTS ferramentas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, uid TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'Disponível')`);
  await run(`CREATE TABLE IF NOT EXISTS movimentacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ferramenta_id INTEGER NOT NULL, usuario_id INTEGER,
    acao TEXT NOT NULL, data_hora TEXT NOT NULL)`);
  await run('CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT)');

  const cols = await all('PRAGMA table_info(movimentacoes)');
  if (!cols.some(c => c.name === 'usuario_id')) await run('ALTER TABLE movimentacoes ADD COLUMN usuario_id INTEGER');
  await run('CREATE INDEX IF NOT EXISTS idx_mov_ferramenta ON movimentacoes(ferramenta_id)');

  // Dados de exemplo apenas na primeira execução (banco vazio).
  const vazio = (await get('SELECT (SELECT COUNT(*) FROM ferramentas) + (SELECT COUNT(*) FROM usuarios) AS n')).n === 0;
  if (vazio) {
    await run("INSERT INTO ferramentas (nome, uid) VALUES ('Chaveiro Azul','17 58 E5 00'), ('Cartão RFID','E9 4F 15 05')");
    await run("INSERT INTO usuarios (nome, matricula) VALUES ('Kauã Teles','001'), ('Lucas Gabriel','002')");
    console.log('Banco novo: dados de exemplo criados.');
  }

  // Recupera o operador escolhido antes de reiniciar o servidor.
  const cfg = await get("SELECT valor FROM config WHERE chave='usuario_ativo'");
  if (cfg) usuarioAtivo = (await get('SELECT id,nome,matricula FROM usuarios WHERE id=?', [cfg.valor])) || null;
}

async function definirOperador(usuario) {
  usuarioAtivo = usuario;
  if (usuario) await run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('usuario_ativo', ?)", [String(usuario.id)]);
  else await run("DELETE FROM config WHERE chave='usuario_ativo'");
}

/* ================= LEITOR RFID (SERIAL) ================= */
const leitor = { conectado: false, pronto: false, porta: null, erro: null, ultimaTag: null, evento: null };
let seq = 0, cadastroAte = 0, processando = false, ultimoUid = '', ultimaLeitura = 0;
let serial = null, conectando = false, buffer = '';

function registrarEvento(tipo, mensagem) { leitor.evento = { id: ++seq, tipo, mensagem, ts: Date.now() }; }

async function escolherPorta() {
  if (PORTA_SERIAL) return PORTA_SERIAL;
  const portas = await SerialPort.list();
  const placa = portas.find(p => ['1A86', '10C4', '0403'].includes((p.vendorId || '').toUpperCase())
    || /wch|silicon|ftdi/i.test(p.manufacturer || ''));
  return placa ? placa.path : null;
}

async function conectarLeitor() {
  if (conectando || (serial && serial.isOpen)) return;
  conectando = true;
  try {
    const caminho = await escolherPorta();
    if (!caminho) { leitor.erro = 'Nenhuma placa USB encontrada. Confira o cabo.'; return; }

    const sp = new SerialPort({ path: caminho, baudRate: BAUD_RATE, autoOpen: false, rtscts: false });
    sp.on('data', aoReceber);
    sp.on('error', e => { leitor.erro = e.message; });
    sp.on('close', () => {
      if (serial === sp) { serial = null; leitor.conectado = false; leitor.pronto = false; console.log('Leitor desconectado. Tentando reconectar...'); }
    });
    await new Promise((ok, no) => sp.open(e => e ? no(e) : ok()));

    serial = sp; buffer = '';
    Object.assign(leitor, { conectado: true, pronto: false, porta: caminho, erro: null });
    console.log(`Leitor conectado em ${caminho}`);

    // Pulso de reset (DTR/RTS): reinicia o ESP8266 e inicializa o RC522.
    sp.set({ dtr: false, rts: true }, () => setTimeout(() => sp.set({ dtr: false, rts: false }, () => {}), 150));
  } catch (e) {
    leitor.conectado = false;
    leitor.erro = /denied|busy|permission/i.test(e.message)
      ? `Porta ocupada. Feche a Arduino IDE e o Monitor Serial. (${e.message})` : e.message;
  } finally { conectando = false; }
}

function aoReceber(dados) {
  buffer += dados.toString('utf8');
  const linhas = buffer.split(/\r\n|\n|\r/);
  buffer = linhas.pop() || '';
  if (buffer.length > 512) buffer = buffer.slice(-128);

  for (const original of linhas) {
    const linha = original.trim();
    if (!linha || !linha.includes('SMARTSTOCK')) continue;   // ignora o lixo do boot
    if (linha === 'SMARTSTOCK|READY') { leitor.pronto = true; console.log('Leitor RFID pronto.'); continue; }
    if (linha.startsWith('SMARTSTOCK|ERROR|')) {
      leitor.erro = 'Diagnóstico: ' + linha.split('|').slice(2).join('|'); console.error(leitor.erro); continue;
    }
    if (!linha.startsWith('SMARTSTOCK|RFID|')) continue;

    const uid = soHex(linha.substring('SMARTSTOCK|RFID|'.length));
    if (!uidValido(uid)) { console.log('UID inválido:', linha); continue; }
    leitor.pronto = true;
    processarTag(uid).catch(e => { console.error('ERRO AO PROCESSAR TAG:', e.message); registrarEvento('erro', 'Erro ao registrar a movimentação.'); });
  }
}

async function processarTag(uid) {
  const agora = Date.now();
  if (uid === ultimoUid && agora - ultimaLeitura < 2500) return;     // leitura repetida
  if (processando) return;
  ultimoUid = uid; ultimaLeitura = agora; processando = true;

  try {
    const bonito = formatarUid(uid);
    leitor.ultimaTag = { uid: bonito, ts: agora };
    console.log('Tag lida:', bonito);

    // Modo cadastro: só captura o UID, sem movimentar estoque.
    if (agora < cadastroAte) { registrarEvento('tag', `Tag lida: ${bonito}`); return; }

    if (!usuarioAtivo) { registrarEvento('sem_operador', 'Tag lida, mas nenhum operador está selecionado.'); console.log('Nenhum operador selecionado.'); return; }

    const f = await get("SELECT * FROM ferramentas WHERE REPLACE(UPPER(uid),' ','') = ?", [uid]);
    if (!f) { registrarEvento('nao_cadastrada', `Tag ${bonito} não está cadastrada.`); console.log('Ferramenta não cadastrada:', bonito); return; }

    const estavaLivre = livre(f.status);
    const acao = estavaLivre ? 'Retirada' : 'Devolução';
    const novo = estavaLivre ? 'Retirada' : 'Disponível';

    // Atualização condicional evita duplicar caso duas leituras colidam.
    const r = await run('UPDATE ferramentas SET status=? WHERE id=? AND status=?', [novo, f.id, f.status]);
    if (!r.changes) return;
    try {
      await run("INSERT INTO movimentacoes (ferramenta_id, usuario_id, acao, data_hora) VALUES (?,?,?,datetime('now','localtime'))",
        [f.id, usuarioAtivo.id, acao]);
    } catch (e) { await run('UPDATE ferramentas SET status=? WHERE id=?', [f.status, f.id]); throw e; }

    registrarEvento('ok', `${acao}: ${f.nome} · ${usuarioAtivo.nome}`);
    console.log(`${acao}: ${f.nome} | ${usuarioAtivo.nome} (${usuarioAtivo.matricula})`);
  } finally { processando = false; }
}

/* ================= API HTTP ================= */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rota = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno do servidor.' }); }
};
const erro = (res, status, msg) => res.status(status).json({ erro: msg });

app.get('/api/health', rota(async (req, res) => { await get('SELECT 1'); res.json({ ok: true }); }));
app.get('/api/leitor', (req, res) => res.json(leitor));
app.post('/api/leitor/cadastro', (req, res) => { cadastroAte = req.body?.ativo ? Date.now() + 30000 : 0; res.json({ sucesso: true }); });

app.get('/api/resumo', rota(async (req, res) => {
  const [f, u, d, r, recentes] = await Promise.all([
    get('SELECT COUNT(*) AS n FROM ferramentas'),
    get('SELECT COUNT(*) AS n FROM usuarios'),
    get("SELECT COUNT(*) AS n FROM ferramentas WHERE status = 'Disponível'"),
    get("SELECT COUNT(*) AS n FROM ferramentas WHERE status <> 'Disponível'"),
    all(`SELECT m.id, f.nome, f.uid, u.nome AS usuario, u.matricula, m.acao, m.data_hora
         FROM movimentacoes m JOIN ferramentas f ON f.id=m.ferramenta_id
         LEFT JOIN usuarios u ON u.id=m.usuario_id ORDER BY m.id DESC LIMIT 8`)
  ]);
  res.json({ totalFerramentas: f.n, totalUsuarios: u.n, disponiveis: d.n, retiradas: r.n, recentes });
}));

/* Usuários */
app.get('/api/usuarios', rota(async (req, res) =>
  res.json(await all('SELECT id,nome,matricula FROM usuarios ORDER BY nome COLLATE NOCASE'))));

app.post('/api/usuarios', rota(async (req, res) => {
  const nome = clean(req.body?.nome), matricula = clean(req.body?.matricula);
  if (!nome || !matricula) return erro(res, 400, 'Nome e matrícula são obrigatórios.');
  try { const r = await run('INSERT INTO usuarios (nome,matricula) VALUES (?,?)', [nome, matricula]); res.status(201).json({ sucesso: true, id: r.id }); }
  catch (e) { if (unico(e)) return erro(res, 400, 'Essa matrícula já está cadastrada.'); throw e; }
}));

app.put('/api/usuarios/:id', rota(async (req, res) => {
  const id = validId(req.params.id), nome = clean(req.body?.nome), matricula = clean(req.body?.matricula);
  if (!id || !nome || !matricula) return erro(res, 400, 'Informe nome e matrícula válidos.');
  try {
    const r = await run('UPDATE usuarios SET nome=?, matricula=? WHERE id=?', [nome, matricula, id]);
    if (!r.changes) return erro(res, 404, 'Usuário não encontrado.');
    if (usuarioAtivo?.id === id) usuarioAtivo = { id, nome, matricula };
    res.json({ sucesso: true });
  } catch (e) { if (unico(e)) return erro(res, 400, 'Essa matrícula já está cadastrada.'); throw e; }
}));

app.delete('/api/usuarios/:id', rota(async (req, res) => {
  const id = validId(req.params.id); if (!id) return erro(res, 400, 'ID inválido.');
  await run('UPDATE movimentacoes SET usuario_id=NULL WHERE usuario_id=?', [id]);
  const r = await run('DELETE FROM usuarios WHERE id=?', [id]);
  if (!r.changes) return erro(res, 404, 'Usuário não encontrado.');
  if (usuarioAtivo?.id === id) await definirOperador(null);
  res.json({ sucesso: true });
}));

/* Operador ativo (persistido no banco) */
app.get('/api/usuario-ativo', (req, res) => res.json({ usuario: usuarioAtivo }));
app.post('/api/usuario-ativo', rota(async (req, res) => {
  const id = validId(req.body?.usuario_id); if (!id) return erro(res, 400, 'Selecione um usuário válido.');
  const u = await get('SELECT id,nome,matricula FROM usuarios WHERE id=?', [id]);
  if (!u) return erro(res, 404, 'Usuário não encontrado.');
  await definirOperador(u);
  console.log(`Operador ativo: ${u.nome} (${u.matricula})`);
  res.json({ sucesso: true, usuario: u });
}));

/* Ferramentas */
app.get('/api/ferramentas', rota(async (req, res) => {
  const b = clean(req.query.busca);
  res.json(b
    ? await all('SELECT id,nome,uid,status FROM ferramentas WHERE nome LIKE ? OR uid LIKE ? ORDER BY nome COLLATE NOCASE', [`%${b}%`, `%${b}%`])
    : await all('SELECT id,nome,uid,status FROM ferramentas ORDER BY nome COLLATE NOCASE'));
}));

app.post('/api/ferramentas', rota(async (req, res) => {
  const nome = clean(req.body?.nome), hex = soHex(req.body?.uid);
  if (!nome || !uidValido(hex)) return erro(res, 400, 'Informe um nome e um UID RFID válido (4, 7 ou 10 bytes).');
  try {
    const r = await run("INSERT INTO ferramentas (nome,uid,status) VALUES (?,?,'Disponível')", [nome, formatarUid(hex)]);
    res.status(201).json({ sucesso: true, id: r.id });
  } catch (e) { if (unico(e)) return erro(res, 400, 'Esse UID RFID já está cadastrado.'); throw e; }
}));

app.put('/api/ferramentas/:id', rota(async (req, res) => {
  const id = validId(req.params.id), nome = clean(req.body?.nome);
  if (!id || !nome) return erro(res, 400, 'Informe um nome válido.');
  const r = await run('UPDATE ferramentas SET nome=? WHERE id=?', [nome, id]);
  if (!r.changes) return erro(res, 404, 'Ferramenta não encontrada.');
  res.json({ sucesso: true });
}));

app.delete('/api/ferramentas/:id', rota(async (req, res) => {
  const id = validId(req.params.id); if (!id) return erro(res, 400, 'ID inválido.');
  const c = await get('SELECT COUNT(*) AS n FROM movimentacoes WHERE ferramenta_id=?', [id]);
  if (c.n) return erro(res, 409, 'Esta ferramenta possui histórico e não pode ser excluída, para preservar as movimentações.');
  const r = await run('DELETE FROM ferramentas WHERE id=?', [id]);
  if (!r.changes) return erro(res, 404, 'Ferramenta não encontrada.');
  res.json({ sucesso: true });
}));

/* Histórico */
app.get('/api/historico', rota(async (req, res) => res.json(await all(
  `SELECT m.id, f.nome, f.uid, u.nome AS usuario, u.matricula, m.acao, m.data_hora
   FROM movimentacoes m LEFT JOIN ferramentas f ON f.id=m.ferramenta_id
   LEFT JOIN usuarios u ON u.id=m.usuario_id ORDER BY m.id DESC`))));

app.use('/api', (req, res) => erro(res, 404, 'Rota não encontrada.'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ================= INICIALIZAÇÃO ================= */
iniciarBanco().then(() => {
  const servidor = app.listen(PORTA_HTTP, () => {
    console.log('\n================================');
    console.log('          SMART STOCK');
    console.log('================================');
    console.log(`Abra no navegador: http://localhost:${PORTA_HTTP}\n`);
    conectarLeitor();
    setInterval(conectarLeitor, 4000);
  });
  servidor.on('error', e => {
    console.error(e.code === 'EADDRINUSE'
      ? `A porta ${PORTA_HTTP} já está em uso. Feche o outro "node" ou use: set PORT=3001`
      : e.message);
    process.exit(1);
  });
}).catch(e => { console.error('Falha ao preparar o banco:', e); process.exit(1); });

process.on('SIGINT', () => {
  console.log('\nEncerrando...');
  const fechar = () => db.close(() => process.exit(0));
  if (serial && serial.isOpen) serial.close(fechar); else fechar();
});

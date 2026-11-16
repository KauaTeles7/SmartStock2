
const express = require('express');

const path = require('path');

const sqlite3 = require('sqlite3').verbose();

const { SerialPort } = require('serialport');

const crypto = require('crypto');
const os = require('os');



const PORTA_HTTP = Number(process.env.PORT || 3000);
const HOST_HTTP = process.env.HOST_HTTP || '0.0.0.0';

function listarIpsRede() {
  const interfaces = os.networkInterfaces();
  const ips = Object.values(interfaces)
    .flatMap(lista => lista || [])
    .filter(info => info && !info.internal && (info.family === 'IPv4' || info.family === 4))
    .map(info => info.address);
  return [...new Set(ips)];
}

const PORTA_SERIAL = process.env.RFID_PORTA || '';   // vazio = detecta automaticamente

const BAUD_RATE = 115200;

const DB_PATH = path.join(__dirname, 'senai_notebooks.db');   // banco NOVO (o smartstock.db antigo não é tocado)



/* Notebooks e tags que entram no banco na primeira execução: [patrimônio, UID da tag colada embaixo]. */

const NOTEBOOKS_INICIAIS = [

  ['1262335', '8F 95 BC D8'], ['1262340', '6F BE 7F D8'], ['1264475', 'DF 49 B1 D8'], ['1262339', '4F 45 0C D8'],

  ['1262341', '4F F8 DD D8'], ['1243237', 'BF CF AB D8'], ['1262336', 'EF 33 42 D8'], ['1243238', '6F 6C DC D8'],

  ['1264476', '7F 0C AE D8'], ['1262324', '4F 9F 66 D8'], ['1262330', 'CF 30 A1 D8'], ['1262329', 'FF 95 42 D8']

];

const ADMIN_INICIAL = { nome: 'Administrador', matricula: 'admin', senha: '12345' };   // troca de senha obrigatória no 1º login



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

const patrimonioOk = v => /^\d{4,12}$/.test(v);

const livre = s => String(s || '').trim().toLocaleLowerCase('pt-BR') === 'disponível';

const unico = e => /UNIQUE/i.test(e.message);



let usuarioAtivo = null;



async function iniciarBanco() {

  await run('PRAGMA foreign_keys = ON');

  await run(`CREATE TABLE IF NOT EXISTS usuarios (

    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, matricula TEXT NOT NULL UNIQUE,

    senha_hash TEXT, perfil TEXT NOT NULL DEFAULT 'professor', trocar_senha INTEGER NOT NULL DEFAULT 1)`);

  await run(`CREATE TABLE IF NOT EXISTS notebooks (

    id INTEGER PRIMARY KEY AUTOINCREMENT, patrimonio TEXT NOT NULL UNIQUE, uid TEXT NOT NULL UNIQUE,

    observacao TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Disponível')`);

  await run(`CREATE TABLE IF NOT EXISTS movimentacoes (

    id INTEGER PRIMARY KEY AUTOINCREMENT, notebook_id INTEGER NOT NULL, usuario_id INTEGER,

    acao TEXT NOT NULL, data_hora TEXT NOT NULL)`);

  await run('CREATE INDEX IF NOT EXISTS idx_mov_notebook ON movimentacoes(notebook_id)');

  await run('CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT)');



  // Banco novo: cadastra os notebooks e suas tags (só quando a tabela está vazia).

  if ((await get('SELECT COUNT(*) AS n FROM notebooks')).n === 0) {

    for (const [pat, uid] of NOTEBOOKS_INICIAIS)

      await run('INSERT OR IGNORE INTO notebooks (patrimonio, uid) VALUES (?,?)', [pat, uid]);

    console.log(`Banco novo: ${NOTEBOOKS_INICIAIS.length} notebooks cadastrados com suas tags.`);

  }



  // Garante ao menos um administrador, com senha provisória (o usuário cadastra a sua no primeiro login).

  if (!(await get("SELECT 1 AS x FROM usuarios WHERE perfil='admin'"))) {

    const primeiro = await get('SELECT MIN(id) AS id FROM usuarios');

    if (primeiro.id) await run("UPDATE usuarios SET perfil='admin' WHERE id=?", [primeiro.id]);

    else {

      await run("INSERT INTO usuarios (nome, matricula, senha_hash, perfil, trocar_senha) VALUES (?,?,?,'admin',1)",

        [ADMIN_INICIAL.nome, ADMIN_INICIAL.matricula, hashSenha(ADMIN_INICIAL.senha)]);

      console.log(`Administrador criado. Login: ${ADMIN_INICIAL.matricula} | senha provisória: ${ADMIN_INICIAL.senha}`);

    }

  }

  for (const a of await all("SELECT id FROM usuarios WHERE perfil='admin' AND (senha_hash IS NULL OR senha_hash='')"))

    await run('UPDATE usuarios SET senha_hash=?, trocar_senha=1 WHERE id=?', [hashSenha(ADMIN_INICIAL.senha), a.id]);



  if (!(await get("SELECT 1 AS x FROM config WHERE chave='estoque_minimo'")))

    await run("INSERT INTO config (chave, valor) VALUES ('estoque_minimo','2')");

  // Após reiniciar o servidor ninguém tem sessão: o leitor só volta a registrar depois de um novo login.

  await definirOperador(null);

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



    // Modo cadastro: só captura o UID, sem movimentar nenhum notebook.

    if (agora < cadastroAte) { registrarEvento('tag', `Tag lida: ${bonito}`); return; }



    if (!usuarioAtivo) { registrarEvento('sem_operador', 'Tag lida, mas nenhum operador está selecionado.'); console.log('Nenhum operador selecionado.'); return; }



    const n = await get("SELECT * FROM notebooks WHERE REPLACE(UPPER(uid),' ','') = ?", [uid]);

    if (!n) { registrarEvento('nao_cadastrada', `Tag ${bonito} não está cadastrada.`); console.log('Notebook não cadastrado:', bonito); return; }



    const estavaLivre = livre(n.status);

    const acao = estavaLivre ? 'Retirada' : 'Devolução';

    const novo = estavaLivre ? 'Retirada' : 'Disponível';



    // Atualização condicional evita duplicar caso duas leituras colidam.

    const r = await run('UPDATE notebooks SET status=? WHERE id=? AND status=?', [novo, n.id, n.status]);

    if (!r.changes) return;

    try {

      await run("INSERT INTO movimentacoes (notebook_id, usuario_id, acao, data_hora) VALUES (?,?,?,datetime('now','localtime'))",

        [n.id, usuarioAtivo.id, acao]);

    } catch (e) { await run('UPDATE notebooks SET status=? WHERE id=?', [n.status, n.id]); throw e; }



    registrarEvento('ok', `${acao}: Notebook ${n.patrimonio} · ${usuarioAtivo.nome}`);

    console.log(`${acao}: Notebook ${n.patrimonio} | ${usuarioAtivo.nome} (${usuarioAtivo.matricula})`);

  } finally { processando = false; }

}



/* ================= API HTTP ================= */

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {

  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });

  next();

});

app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, 'public')));



const rota = fn => async (req, res) => {

  try { await fn(req, res); }

  catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno do servidor.' }); }

};

const erro = (res, status, msg) => res.status(status).json({ erro: msg });



/* ================= AUTENTICAÇÃO ================= */

const SESSAO_MS = 8 * 3600e3;

const sessoes = new Map(), falhas = new Map();

function hashSenha(p) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex'); }

function confereSenha(p, h) {

  try {

    const [salt, hex] = String(h || '').split(':'); if (!salt || !hex) return false;

    const a = Buffer.from(hex, 'hex'), b = crypto.scryptSync(p, salt, 64);

    return a.length === b.length && crypto.timingSafeEqual(a, b);

  } catch { return false; }

}

function lerCookie(req, nome) {

  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(nome + '='));

  return c ? decodeURIComponent(c.slice(nome.length + 1)) : null;

}

function sessaoDe(req) {

  const id = lerCookie(req, 'sid'), x = id && sessoes.get(id);

  if (!x) return null;

  if (x.exp < Date.now()) { sessoes.delete(id); return null; }

  x.exp = Date.now() + SESSAO_MS;

  return { id, usuario: x.usuario };

}

const senhaOk = p => typeof p === 'string' && p.length >= 5;



app.use('/api', (req, res, next) => {

  res.set('Cache-Control', 'no-store');

  if (req.path === '/login' || req.path === '/health') return next();

  const x = sessaoDe(req);

  if (!x) return erro(res, 401, 'Faça login para continuar.');

  if (x.usuario.trocar && !['/senha', '/sessao', '/logout'].includes(req.path))

    return erro(res, 403, 'Cadastre sua nova senha para continuar.');

  req.sessao = x; next();

});



const soAdmin = (req, res, next) =>

  req.sessao.usuario.perfil === 'admin' ? next() : erro(res, 403, 'Apenas administradores podem fazer isso.');



async function abrirSessao(req, res, u) {

  const usuario = { id: u.id, nome: u.nome, matricula: u.matricula, perfil: u.perfil, trocar: !!u.trocar_senha };

  const id = crypto.randomBytes(32).toString('hex');

  sessoes.set(id, { usuario, exp: Date.now() + SESSAO_MS });

  res.set('Set-Cookie', `sid=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_MS / 1000}${req.secure ? '; Secure' : ''}`);

  if (!usuario.trocar) await definirOperador(usuario);   // quem entrou passa a ser o operador do leitor

  console.log(`Login: ${u.nome} (${u.matricula}, ${u.perfil})`);

  res.json({ sucesso: true, usuario });

}



app.post('/api/login', rota(async (req, res) => {

  const mat = clean(req.body?.matricula), senha = typeof req.body?.senha === 'string' ? req.body.senha : '';

  const chave = `${req.ip}|${mat}`, f = falhas.get(chave) || { n: 0, ate: 0 };

  if (f.ate > Date.now()) return erro(res, 429, 'Muitas tentativas erradas. Aguarde 15 minutos.');

  const u = mat ? await get('SELECT id,nome,matricula,perfil,trocar_senha,senha_hash FROM usuarios WHERE matricula=?', [mat]) : null;

  if (!u || !confereSenha(senha, u.senha_hash)) {

    f.n++; if (f.n >= 5) { f.n = 0; f.ate = Date.now() + 15 * 60e3; }

    falhas.set(chave, f);

    console.log(`Login recusado: matrícula "${mat}" (${req.ip})`);

    return erro(res, 401, 'Matrícula ou senha incorretos.');

  }

  falhas.delete(chave);

  await abrirSessao(req, res, u);

}));



app.post('/api/senha', rota(async (req, res) => {

  const me = req.sessao.usuario, { atual, nova } = req.body || {};

  const u = await get('SELECT matricula,senha_hash FROM usuarios WHERE id=?', [me.id]);

  if (!u) return erro(res, 404, 'Usuário não encontrado.');

  if (!me.trocar && !confereSenha(String(atual || ''), u.senha_hash)) return erro(res, 400, 'A senha atual está incorreta.');

  if (!senhaOk(nova)) return erro(res, 400, 'A nova senha deve ter pelo menos 5 caracteres.');

  if (nova === u.matricula) return erro(res, 400, 'A senha não pode ser igual à matrícula.');

  if (confereSenha(nova, u.senha_hash)) return erro(res, 400, 'Escolha uma senha diferente da atual.');

  await run('UPDATE usuarios SET senha_hash=?, trocar_senha=0 WHERE id=?', [hashSenha(nova), me.id]);

  me.trocar = false;

  await definirOperador(me);

  console.log(`Senha cadastrada: ${me.nome}`);

  res.json({ sucesso: true });

}));



app.put('/api/config', soAdmin, rota(async (req, res) => {

  const n = Number(req.body?.estoque_minimo);

  if (!Number.isInteger(n) || n < 0 || n > 999) return erro(res, 400, 'Informe um número inteiro entre 0 e 999.');

  await run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('estoque_minimo', ?)", [String(n)]);

  res.json({ sucesso: true, estoque_minimo: n });

}));



/* Apaga o histórico de testes e libera todos os notebooks (cadastros e usuários são mantidos). */

app.post('/api/admin/reiniciar', soAdmin, rota(async (req, res) => {

  const u = await get('SELECT senha_hash FROM usuarios WHERE id=?', [req.sessao.usuario.id]);

  if (!confereSenha(String(req.body?.senha || ''), u?.senha_hash)) return erro(res, 400, 'Senha incorreta.');

  await run('DELETE FROM movimentacoes');

  await run("DELETE FROM sqlite_sequence WHERE name='movimentacoes'");

  await run("UPDATE notebooks SET status='Disponível'");

  console.log(`Histórico apagado e notebooks liberados por ${req.sessao.usuario.nome}`);

  res.json({ sucesso: true });

}));



app.put('/api/usuarios/:id/perfil', soAdmin, rota(async (req, res) => {

  const id = validId(req.params.id), perfil = req.body?.perfil;

  if (!id || !['admin', 'professor'].includes(perfil)) return erro(res, 400, 'Perfil inválido.');

  if (perfil !== 'admin' && (await get("SELECT COUNT(*) AS n FROM usuarios WHERE perfil='admin' AND id<>?", [id])).n === 0)

    return erro(res, 400, 'Precisa existir pelo menos um administrador.');

  const r = await run('UPDATE usuarios SET perfil=? WHERE id=?', [perfil, id]);

  if (!r.changes) return erro(res, 404, 'Usuário não encontrado.');

  for (const x of sessoes.values()) if (x.usuario.id === id) x.usuario.perfil = perfil;

  res.json({ sucesso: true });

}));



app.get('/api/sessao', (req, res) => res.json({ usuario: req.sessao.usuario }));



app.post('/api/logout', rota(async (req, res) => {

  sessoes.delete(req.sessao.id);

  if (usuarioAtivo?.id === req.sessao.usuario.id) await definirOperador(null);

  res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');

  console.log(`Logout: ${req.sessao.usuario.nome}`);

  res.json({ sucesso: true });

}));



app.get('/api/health', rota(async (req, res) => { await get('SELECT 1'); res.json({ ok: true }); }));

app.get('/api/leitor', (req, res) => res.json(leitor));

app.post('/api/leitor/cadastro', soAdmin, (req, res) => { cadastroAte = req.body?.ativo ? Date.now() + 30000 : 0; res.json({ sucesso: true }); });



app.get('/api/resumo', rota(async (req, res) => {

  const [t, u, d, recentes] = await Promise.all([

    get('SELECT COUNT(*) AS n FROM notebooks'),

    get('SELECT COUNT(*) AS n FROM usuarios'),

    get("SELECT COUNT(*) AS n FROM notebooks WHERE status = 'Disponível'"),

    all(`SELECT m.id, n.patrimonio, n.uid, u.nome AS usuario, u.matricula, m.acao, m.data_hora

         FROM movimentacoes m JOIN notebooks n ON n.id=m.notebook_id

         LEFT JOIN usuarios u ON u.id=m.usuario_id ORDER BY m.id DESC LIMIT 8`)

  ]);

  const m = await get("SELECT valor FROM config WHERE chave='estoque_minimo'");

  res.json({ totalNotebooks: t.n, totalUsuarios: u.n, disponiveis: d.n, emUso: t.n - d.n, recentes, estoqueMinimo: m ? Number(m.valor) : 2 });

}));



/* Usuários */

app.get('/api/usuarios', rota(async (req, res) => {

  const l = await all("SELECT id,nome,matricula,perfil,(senha_hash IS NOT NULL AND senha_hash<>'') AS tem_senha,trocar_senha FROM usuarios ORDER BY nome COLLATE NOCASE");

  res.json(req.sessao.usuario.perfil === 'admin' ? l : l.map(({ id, nome, matricula, perfil }) => ({ id, nome, matricula, perfil })));

}));



app.post('/api/usuarios', soAdmin, rota(async (req, res) => {

  const nome = clean(req.body?.nome), matricula = clean(req.body?.matricula);

  if (!nome || !matricula) return erro(res, 400, 'Nome e matrícula são obrigatórios.');

  const senha = req.body?.senha; if (!senhaOk(senha)) return erro(res, 400, 'A senha deve ter pelo menos 5 caracteres.');

  try { const r = await run('INSERT INTO usuarios (nome,matricula,senha_hash,trocar_senha) VALUES (?,?,?,1)', [nome, matricula, hashSenha(senha)]); res.status(201).json({ sucesso: true, id: r.id }); }

  catch (e) { if (unico(e)) return erro(res, 400, 'Essa matrícula já está cadastrada.'); throw e; }

}));



app.put('/api/usuarios/:id', soAdmin, rota(async (req, res) => {

  const id = validId(req.params.id), nome = clean(req.body?.nome), matricula = clean(req.body?.matricula);

  if (!id || !nome || !matricula) return erro(res, 400, 'Informe nome e matrícula válidos.');

  try {

    const senha = req.body?.senha;

    if (senha) {

      if (!senhaOk(senha)) return erro(res, 400, 'A senha deve ter pelo menos 5 caracteres.');

      const eu = id === req.sessao.usuario.id;

      await run('UPDATE usuarios SET senha_hash=?, trocar_senha=? WHERE id=?', [hashSenha(senha), eu ? 0 : 1, id]);

      if (!eu) for (const [k, x] of sessoes) if (x.usuario.id === id) sessoes.delete(k);   // senha provisória derruba sessões dele

    }

    const r = await run('UPDATE usuarios SET nome=?, matricula=? WHERE id=?', [nome, matricula, id]);

    if (!r.changes) return erro(res, 404, 'Usuário não encontrado.');

    if (usuarioAtivo?.id === id) usuarioAtivo = { id, nome, matricula };

    res.json({ sucesso: true });

  } catch (e) { if (unico(e)) return erro(res, 400, 'Essa matrícula já está cadastrada.'); throw e; }

}));



app.delete('/api/usuarios/:id', soAdmin, rota(async (req, res) => {

  const id = validId(req.params.id); if (!id) return erro(res, 400, 'ID inválido.');

  if (id === req.sessao.usuario.id) return erro(res, 400, 'Você não pode excluir o usuário com o qual está logado.');

  for (const [k, x] of sessoes) if (x.usuario.id === id) sessoes.delete(k);

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

  if (id !== req.sessao.usuario.id) return erro(res, 403, 'Você só pode assumir o leitor com o seu próprio usuário.');

  const u = await get('SELECT id,nome,matricula FROM usuarios WHERE id=?', [id]);

  if (!u) return erro(res, 404, 'Usuário não encontrado.');

  await definirOperador(u);

  console.log(`Operador ativo: ${u.nome} (${u.matricula})`);

  res.json({ sucesso: true, usuario: u });

}));



/* Notebooks (com quem está e desde quando, calculado pela última retirada) */

app.get('/api/notebooks', rota(async (req, res) => {

  const l = await all(`SELECT n.id, n.patrimonio, n.uid, n.observacao, n.status,

      mu.data_hora AS ultima, mr.data_hora AS desde, ur.nome AS responsavel, ur.matricula AS resp_matricula

    FROM notebooks n

    LEFT JOIN movimentacoes mu ON mu.id = (SELECT MAX(id) FROM movimentacoes WHERE notebook_id = n.id)

    LEFT JOIN movimentacoes mr ON mr.id = (SELECT MAX(id) FROM movimentacoes WHERE notebook_id = n.id AND acao = 'Retirada')

    LEFT JOIN usuarios ur ON ur.id = mr.usuario_id

    ORDER BY CAST(n.patrimonio AS INTEGER), n.patrimonio`);

  res.json(l.map(n => livre(n.status) ? { ...n, desde: null, responsavel: null, resp_matricula: null } : n));

}));



function dadosNotebook(req) {

  return { pat: clean(req.body?.patrimonio), hex: soHex(req.body?.uid), obs: clean(req.body?.observacao).slice(0, 120) };

}

function erroNotebook(res, e) {

  if (!unico(e)) return false;

  erro(res, 400, /notebooks\.patrimonio/i.test(e.message) ? 'Esse patrimônio já está cadastrado.' : 'Essa tag RFID já está cadastrada em outro notebook.');

  return true;

}



app.post('/api/notebooks', soAdmin, rota(async (req, res) => {

  const { pat, hex, obs } = dadosNotebook(req);

  if (!patrimonioOk(pat)) return erro(res, 400, 'Informe o número de patrimônio (somente números).');

  if (!uidValido(hex)) return erro(res, 400, 'Informe um UID RFID válido (4, 7 ou 10 bytes).');

  try {

    const r = await run("INSERT INTO notebooks (patrimonio,uid,observacao,status) VALUES (?,?,?,'Disponível')", [pat, formatarUid(hex), obs]);

    res.status(201).json({ sucesso: true, id: r.id });

  } catch (e) { if (erroNotebook(res, e)) return; throw e; }

}));



app.put('/api/notebooks/:id', soAdmin, rota(async (req, res) => {

  const id = validId(req.params.id), { pat, hex, obs } = dadosNotebook(req);

  if (!id) return erro(res, 400, 'ID inválido.');

  if (!patrimonioOk(pat)) return erro(res, 400, 'Informe o número de patrimônio (somente números).');

  if (!uidValido(hex)) return erro(res, 400, 'Informe um UID RFID válido (4, 7 ou 10 bytes).');

  try {

    const r = await run('UPDATE notebooks SET patrimonio=?, uid=?, observacao=? WHERE id=?', [pat, formatarUid(hex), obs, id]);

    if (!r.changes) return erro(res, 404, 'Notebook não encontrado.');

    res.json({ sucesso: true });

  } catch (e) { if (erroNotebook(res, e)) return; throw e; }

}));



app.delete('/api/notebooks/:id', soAdmin, rota(async (req, res) => {

  const id = validId(req.params.id); if (!id) return erro(res, 400, 'ID inválido.');

  const c = await get('SELECT COUNT(*) AS n FROM movimentacoes WHERE notebook_id=?', [id]);

  if (c.n) return erro(res, 409, 'Este notebook possui histórico e não pode ser excluído, para preservar as movimentações.');

  const r = await run('DELETE FROM notebooks WHERE id=?', [id]);

  if (!r.changes) return erro(res, 404, 'Notebook não encontrado.');

  res.json({ sucesso: true });

}));



/* Histórico */

app.get('/api/historico', rota(async (req, res) => res.json(await all(

  `SELECT m.id, n.patrimonio, n.uid, n.observacao, u.nome AS usuario, u.matricula, m.acao, m.data_hora

   FROM movimentacoes m LEFT JOIN notebooks n ON n.id=m.notebook_id

   LEFT JOIN usuarios u ON u.id=m.usuario_id ORDER BY m.id DESC`))));



app.use('/api', (req, res) => erro(res, 404, 'Rota não encontrada.'));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));



/* ================= INICIALIZAÇÃO ================= */

iniciarBanco().then(() => {

  const servidor = app.listen(PORTA_HTTP, HOST_HTTP, () => {

    console.log('\n================================');
    console.log('       SMART STOCK · NOTEBOOKS');
    console.log('================================');
    console.log(`Servidor iniciado na porta ${PORTA_HTTP}.`);
    console.log(`Acesso neste notebook: http://localhost:${PORTA_HTTP}`);

    const ips = listarIpsRede();
    if (ips.length) {
      console.log('\nACESSO PELA REDE (tablet Android):');
      ips.forEach(ip => console.log(`http://${ip}:${PORTA_HTTP}`));
    } else {
      console.log('\nNenhum endereço IPv4 de rede foi encontrado.');
    }

    console.log('\nInicializando leitor RFID...');
    conectarLeitor();
    setInterval(conectarLeitor, 4000);

    setInterval(() => {   // encerra sessões vencidas e libera o operador do leitor
      for (const [id, x] of sessoes) if (x.exp < Date.now()) {
        sessoes.delete(id);
        if (usuarioAtivo?.id === x.usuario.id) definirOperador(null).catch(() => {});
      }
    }, 60000);

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
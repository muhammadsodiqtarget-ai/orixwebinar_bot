// index.js — @orixwebinar_bot
// Full bot: webinar registration flow + persistent lead storage + admin panel.
//
// ENV VARS REQUIRED (set these in Railway → Variables):
//   BOT_TOKEN       - from @BotFather
//   ADMIN_IDS       - comma-separated Telegram user IDs allowed to use admin commands, e.g. "123456789,987654321"
//   CHANNEL_LINK    - e.g. https://t.me/orix_global_agency
//   GOOGLE_SCRIPT_URL - the Apps Script Web App URL already used by the landing page (optional but recommended)
//   LEADS_DB_PATH   - where the lead database file lives, e.g. /data/leads.json
//                     ⚠️ THIS PATH MUST BE ON A RAILWAY PERSISTENT VOLUME.
//                     If it's on the regular container filesystem, every redeploy WIPES all leads.
//                     Railway → your service → Settings → Volumes → mount a volume at e.g. /data,
//                     then set LEADS_DB_PATH=/data/leads.json

const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const CHANNEL_LINK = process.env.CHANNEL_LINK || 'https://t.me/orix_global_agency';
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';
const DB_PATH = process.env.LEADS_DB_PATH || path.join(__dirname, 'data', 'leads.json');

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN env var is missing. Set it in Railway → Variables.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------------------------------------------------------------------------
// PERSISTENT LEAD STORE
// Leads are NEVER deleted. This file is append/update-only via upsertLead().
// Stored as { [user_id]: leadObject } for O(1) lookups, but exported/iterated
// as an array wherever needed.
// ---------------------------------------------------------------------------

function ensureDbFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}), 'utf8');
}

function loadDb() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('Failed to read leads DB, starting from an empty in-memory copy (file on disk is untouched):', err);
    return {};
  }
}

function saveDb(db) {
  ensureDbFile();
  // write to a temp file then rename — avoids a half-written file if the process
  // crashes mid-write
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_PATH);
}

function upsertLead(userId, patch) {
  const db = loadDb();
  const key = String(userId);
  const existing = db[key] || {
    user_id: userId,
    username: '',
    name: '',
    phone: '',
    status: 'started',
    created_at: new Date().toISOString()
  };
  db[key] = Object.assign(existing, patch, { updated_at: new Date().toISOString() });
  saveDb(db);
  return db[key];
}

function getLead(userId) {
  const db = loadDb();
  return db[String(userId)] || null;
}

function allLeads() {
  const db = loadDb();
  return Object.values(db);
}

// ---------------------------------------------------------------------------
// GOOGLE SHEETS FORWARDING (best-effort, never blocks the user flow)
// ---------------------------------------------------------------------------

async function forwardToSheets(lead) {
  if (!GOOGLE_SCRIPT_URL) return;
  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        name: lead.name,
        phone: lead.phone,
        telegram: lead.username ? '@' + lead.username : '',
        source: 'telegram-bot-webinar',
        submitted_at: lead.updated_at
      })
    });
  } catch (err) {
    console.error('Failed to forward lead to Sheets (lead is still saved locally):', err);
  }
}

// ---------------------------------------------------------------------------
// ADMIN AUTH
// ---------------------------------------------------------------------------

function isAdmin(ctx) {
  return ADMIN_IDS.includes(ctx.from.id);
}

function requireAdmin(ctx, next) {
  if (!isAdmin(ctx)) return; // silently ignore — don't reveal admin commands exist to non-admins
  return next();
}

// ---------------------------------------------------------------------------
// PENDING-STATE TRACKING (in-memory — only tracks "where in the flow" a user
// is right now; the actual lead data itself lives in the persistent DB above)
// ---------------------------------------------------------------------------

const pendingStep = new Map(); // user_id -> 'name' | 'phone'

const PHONE_REGEX = /^\+?\d{9,15}$/;

function contactKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: '📱 Telefon raqamni yuborish', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

async function completeRegistration(ctx, lead) {
  await ctx.reply(
    "🎉 Tabriklaymiz!\n\n" +
    "Balkim hammasi shu yerdan boshlanar. Sizdan yana uchta qadam qoldi 👇🏻\n\n" +
    `1. Hoziroq kanalga qo'shilib oling: ${CHANNEL_LINK}\n` +
    "2. Kanalni «PIN» qiling\n" +
    "3. «Уведомления»ni yoqing\n\n" +
    "Chunki, sizga vebinargacha ham mavzuga doir eng go'shtli va foydali bilimlar berib boramiz 🔥",
    { reply_markup: { remove_keyboard: true } }
  );
  forwardToSheets(lead);
}

// ---------------------------------------------------------------------------
// REGISTRATION FLOW
// ---------------------------------------------------------------------------

bot.start(async (ctx) => {
  upsertLead(ctx.from.id, {
    username: ctx.from.username || '',
    status: 'started'
  });
  pendingStep.set(ctx.from.id, 'name');

  await ctx.reply(
    "🇰🇷 Xush kelibsiz, Koreada GRANT asosida o'qish sari qadam qo'ygan inson!\n\n" +
    "Kanalga qo'shilishingiz uchun yana bir qadam qoldi.\n\n" +
    "Ismingizni yozib yuboring ✍️"
  );
});

// Handles both the "name" step and manually-typed phone numbers
bot.on('text', async (ctx, next) => {
  const step = pendingStep.get(ctx.from.id);
  if (!step) return next(); // not in this flow — let other handlers (admin commands etc.) run

  const text = ctx.message.text.trim();

  if (step === 'name') {
    upsertLead(ctx.from.id, { name: text, status: 'pending_phone' });
    pendingStep.set(ctx.from.id, 'phone');
    return ctx.reply(
      `Rahmat, ${text}! 🙌\n\nEndi telefon raqamingizni yuboring.\nNamuna: +998901234567\nyoki pastdagi tugmani bosing 👇`,
      contactKeyboard()
    );
  }

  if (step === 'phone') {
    if (!PHONE_REGEX.test(text.replace(/[\s()-]/g, ''))) {
      return ctx.reply("Raqam noto'g'ri ko'rinmoqda. Namuna: +998901234567, yoki pastdagi tugmani bosing 👇", contactKeyboard());
    }
    const lead = upsertLead(ctx.from.id, { phone: text, status: 'completed' });
    pendingStep.delete(ctx.from.id);
    return completeRegistration(ctx, lead);
  }

  return next();
});

// Handles the "share contact" button
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  if (contact.user_id && contact.user_id !== ctx.from.id) {
    return ctx.reply("Iltimos, FAQAT o'zingizning raqamingizni yuboring.");
  }

  const existing = getLead(ctx.from.id);
  const name = (existing && existing.name) || [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');

  const lead = upsertLead(ctx.from.id, {
    name,
    phone: contact.phone_number,
    status: 'completed'
  });
  pendingStep.delete(ctx.from.id);
  await completeRegistration(ctx, lead);
});

// ---------------------------------------------------------------------------
// ADMIN PANEL
// ---------------------------------------------------------------------------

bot.command('stats', (ctx) => requireAdmin(ctx, async () => {
  const leads = allLeads();
  const completed = leads.filter(l => l.status === 'completed').length;
  const pending = leads.filter(l => l.status !== 'completed').length;
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = leads.filter(l => (l.created_at || '').slice(0, 10) === today).length;

  await ctx.reply(
    `📊 Statistika\n\n` +
    `Jami: ${leads.length}\n` +
    `To'liq ro'yxatdan o'tgan: ${completed}\n` +
    `Yarim yo'lda to'xtagan: ${pending}\n` +
    `Bugun kelgan: ${todayCount}`
  );
}));

bot.command('leads', (ctx) => requireAdmin(ctx, async () => {
  const leads = allLeads()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 20);

  if (leads.length === 0) return ctx.reply('Hali leadlar yo\'q.');

  const lines = leads.map((l, i) =>
    `${i + 1}. ${l.name || '—'} | ${l.phone || '—'} | @${l.username || '—'} | ${l.status}`
  );
  await ctx.reply(`So'nggi ${leads.length} ta lead:\n\n` + lines.join('\n'));
}));

bot.command('export', (ctx) => requireAdmin(ctx, async () => {
  const leads = allLeads();
  const header = 'user_id,username,name,phone,status,created_at,updated_at';
  const rows = leads.map(l => [
    l.user_id, l.username, l.name, l.phone, l.status, l.created_at, l.updated_at
  ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
  const csv = [header, ...rows].join('\n');

  await ctx.replyWithDocument({
    source: Buffer.from(csv, 'utf8'),
    filename: `leads-${new Date().toISOString().slice(0, 10)}.csv`
  });
}));

bot.command('import_leads', (ctx) => requireAdmin(ctx, async () => {
  const replyMsg = ctx.message.reply_to_message;
  if (!replyMsg || !replyMsg.document) {
    return ctx.reply('CSV faylga reply qilib /import_leads yozing.');
  }
  try {
    const fileLink = await ctx.telegram.getFileLink(replyMsg.document.file_id);
    const res = await fetch(fileLink.href || fileLink);
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1); // skip header
    let count = 0;
    for (const line of lines) {
      const cols = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
      const clean = cols.map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
      const [user_id, username, name, phone, status, created_at, updated_at] = clean;
      if (!user_id) continue;
      const db = loadDb();
      db[String(user_id)] = {
        user_id: Number(user_id), username, name, phone,
        status: status || 'completed',
        created_at: created_at || new Date().toISOString(),
        updated_at: updated_at || new Date().toISOString()
      };
      saveDb(db);
      count++;
    }
    await ctx.reply(`✅ ${count} ta lead import qilindi.`);
  } catch (err) {
    console.error('Import failed:', err);
    await ctx.reply("Import qilishda xatolik yuz berdi. Faylni tekshiring.");
  }
}));

// ---------------------------------------------------------------------------
// BROADCASTS
// A small delay between sends avoids Telegram's flood limits. Blocked/deleted
// users are skipped silently instead of crashing the whole broadcast.
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function broadcastToAll(ctx, sendFn) {
  const leads = allLeads();
  let sent = 0, failed = 0;
  await ctx.reply(`Yuborish boshlandi: ${leads.length} kishiga...`);
  for (const lead of leads) {
    try {
      await sendFn(lead.user_id);
      sent++;
    } catch (err) {
      failed++;
    }
    await sleep(60); // ~16 messages/sec, safely under Telegram's limits
  }
  await ctx.reply(`✅ Tugadi. Yuborildi: ${sent}, xato: ${failed}`);
}

bot.command('broadcast', (ctx) => requireAdmin(ctx, async () => {
  const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/, '');
  if (!text) return ctx.reply('Foydalanish: /broadcast Xabar matni');
  await broadcastToAll(ctx, (userId) => ctx.telegram.sendMessage(userId, text));
}));

bot.command('broadcast_photo', (ctx) => requireAdmin(ctx, async () => {
  const replyMsg = ctx.message.reply_to_message;
  if (!replyMsg || !replyMsg.photo) return ctx.reply("Rasmga reply qilib /broadcast_photo [matn] yozing.");
  const caption = ctx.message.text.replace(/^\/broadcast_photo(@\w+)?\s*/, '');
  const fileId = replyMsg.photo[replyMsg.photo.length - 1].file_id;
  await broadcastToAll(ctx, (userId) => ctx.telegram.sendPhoto(userId, fileId, { caption }));
}));

bot.command('broadcast_video', (ctx) => requireAdmin(ctx, async () => {
  const replyMsg = ctx.message.reply_to_message;
  if (!replyMsg || !replyMsg.video_note) return ctx.reply("Yumaloq videoga reply qilib /broadcast_video yozing.");
  const fileId = replyMsg.video_note.file_id;
  await broadcastToAll(ctx, (userId) => ctx.telegram.sendVideoNote(userId, fileId));
}));

bot.command('broadcast_voice', (ctx) => requireAdmin(ctx, async () => {
  const replyMsg = ctx.message.reply_to_message;
  if (!replyMsg || !replyMsg.voice) return ctx.reply("Ovozli xabarga reply qilib /broadcast_voice yozing.");
  const fileId = replyMsg.voice.file_id;
  await broadcastToAll(ctx, (userId) => ctx.telegram.sendVoice(userId, fileId));
}));

bot.command('reminder', (ctx) => requireAdmin(ctx, async () => {
  const stuck = allLeads().filter(l => l.status !== 'completed');
  if (stuck.length === 0) return ctx.reply("Yarim yo'lda to'xtagan hech kim yo'q 🎉");
  const text = "Salom! Vebinar kanaliga qo'shilish uchun ro'yxatdan o'tishni yakunlamagansiz. Davom etish uchun telefon raqamingizni yuboring 👇";
  await broadcastToAll(ctx, (userId) =>
    ctx.telegram.sendMessage(userId, text, contactKeyboard())
  );
}));

// ---------------------------------------------------------------------------
// ADMIN MENU (/admin) — button-based menu that groups the admin commands above
// ---------------------------------------------------------------------------

bot.command('admin', (ctx) => requireAdmin(ctx, async () => {
    await ctx.reply('🛠 Admin panel — kerakli bo\'limni tanlang:', {
          reply_markup: {
                  inline_keyboard: [
                            [{ text: '📊 Statistika', callback_data: 'admin_stats' }, { text: '👥 Leadlar', callback_data: 'admin_leads' }],
                            [{ text: '📤 Export CSV', callback_data: 'admin_export' }, { text: '⏰ Reminder', callback_data: 'admin_reminder' }],
                            [{ text: 'ℹ️ Broadcast yordam', callback_data: 'admin_broadcast_help' }]
                          ]
          }
    });
}));

bot.action('admin_stats', (ctx) => requireAdmin(ctx, async () => {
    await ctx.answerCbQuery();
    const leads = allLeads();
    const completed = leads.filter(l => l.status === 'completed').length;
    const pending = leads.filter(l => l.status !== 'completed').length;
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = leads.filter(l => (l.created_at || '').slice(0, 10) === today).length;
    await ctx.reply(
          `📊 Statistika\n\n` +
          `Jami: ${leads.length}\n` +
          `To'liq ro'yxatdan o'tgan: ${completed}\n` +
          `Yarim yo'lda to'xtagan: ${pending}\n` +
          `Bugun kelgan: ${todayCount}`
        );
}));

bot.action('admin_leads', (ctx) => requireAdmin(ctx, async () => {
    await ctx.answerCbQuery();
    const leads = allLeads().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);
    if (leads.length === 0) return ctx.reply('Hali leadlar yo\'q.');
    const lines = leads.map((l, i) => `${i + 1}. ${l.name || '—'} | ${l.phone || '—'} | @${l.username || '—'} | ${l.status}`);
    await ctx.reply(`So'nggi ${leads.length} ta lead:\n\n` + lines.join('\n'));
}));

bot.action('admin_export', (ctx) => requireAdmin(ctx, async () => {
    await ctx.answerCbQuery();
    const leads = allLeads();
    const header = 'user_id,username,name,phone,status,created_at,updated_at';
    const rows = leads.map(l => [
          l.user_id, l.username, l.name, l.phone, l.status, l.created_at, l.updated_at
        ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
    const csv = [header, ...rows].join('\n');
    await ctx.replyWithDocument({
          source: Buffer.from(csv, 'utf8'),
          filename: `leads-${new Date().toISOString().slice(0, 10)}.csv`
    });
}));

bot.action('admin_reminder', (ctx) => requireAdmin(ctx, async () => {
    await ctx.answerCbQuery();
    const stuck = allLeads().filter(l => l.status !== 'completed');
    if (stuck.length === 0) return ctx.reply("Yarim yo'lda to'xtagan hech kim yo'q 🎉");
    const text = "Salom! Vebinar kanaliga qo'shilish uchun ro'yxatdan o'tishni yakunlamagansiz. Davom etish uchun telefon raqamingizni yuboring 👇";
    await broadcastToAll(ctx, (userId) => ctx.telegram.sendMessage(userId, text, contactKeyboard()));
}));

bot.action('admin_broadcast_help', (ctx) => requireAdmin(ctx, async () => {
    await ctx.answerCbQuery();
    await ctx.reply(
          "Quyidagi buyruqlarni qo'lda yuboring:\n\n" +
          "/broadcast Matn — hammaga matn yuborish\n" +
          "/broadcast_photo Matn — (rasmga reply qilib)\n" +
          "/broadcast_video — (yumaloq videoga reply qilib)\n" +
          "/broadcast_voice — (ovozli xabarga reply qilib)\n" +
          "/import_leads — (CSV faylga reply qilib)"
        );
}));

// ---------------------------------------------------------------------------
bot.launch();
console.log('Bot started. Leads DB path:', DB_PATH);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

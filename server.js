const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change_me_123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'super_secret_session_key_change_me';
const COPYCENTER_NAME = process.env.COPYCENTER_NAME || 'LADOGA';
const COPYCENTER_PHONE = process.env.COPYCENTER_PHONE || '+7 (999) 123-45-67';
const COPYCENTER_EMAIL = process.env.COPYCENTER_EMAIL || 'print@example.com';
const COPYCENTER_ADDRESS = process.env.COPYCENTER_ADDRESS || 'г. Москва, ул. Пример, 10';
const UPLOAD_MAX_FILES = Number(process.env.UPLOAD_MAX_FILES || 20);
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 100);

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

ensureDir(DATA_DIR);
ensureDir(UPLOADS_DIR);
ensureOrdersFile();

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT_DIR, 'views'));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 24 },
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = path.join(UPLOADS_DIR, new Date().toISOString().slice(0, 7));
    ensureDir(folder);
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const allowedExtensions = new Set(['.pdf','.doc','.docx','.txt','.rtf','.jpg','.jpeg','.png','.webp','.tif','.tiff','.cdr','.ai','.psd','.xls','.xlsx','.ppt','.pptx']);
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024, files: UPLOAD_MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedExtensions.has(ext)) return cb(new Error(`Неподдерживаемый формат: ${file.originalname}`));
    cb(null, true);
  },
});

const paperOptions = ['A5', 'A4', 'A3', 'A2', 'A1', 'A0'];
const fillOptions = [
  { value: 'scale1', label: 'До 5%' },
  { value: 'scale2', label: '5–50%' },
  { value: 'scale3', label: 'От 50%' },
];
const priceTable = {
  bw: {
    scale1: { A5: null, A4: 20, A3: 40, A2: 100, A1: 150, A0: 250 },
    scale2: { A5: null, A4: 30, A3: 60, A2: 150, A1: 250, A0: 400 },
    scale3: { A5: null, A4: 60, A3: 120, A2: 300, A1: 500, A0: 800 },
  },
  color: {
    scale1: { A5: null, A4: 40, A3: 80, A2: 150, A1: 250, A0: 350 },
    scale2: { A5: null, A4: 60, A3: 120, A2: 250, A1: 500, A0: 700 },
    scale3: { A5: null, A4: 90, A3: 180, A2: 500, A1: 800, A0: 1100 },
  },
};
const statuses = ['Новый', 'В работе', 'Готов', 'Выдан'];

app.locals.site = {
  name: COPYCENTER_NAME,
  phone: COPYCENTER_PHONE,
  email: COPYCENTER_EMAIL,
  address: COPYCENTER_ADDRESS,
  logoPath: '/logo-ladoga.png',
};
app.locals.paperOptions = paperOptions;
app.locals.fillOptions = fillOptions;
app.locals.statuses = statuses;
app.locals.priceTable = priceTable;

app.get('/', (req, res) => {
  res.render('index', {
    success: req.query.success === '1',
    error: String(req.query.error || ''),
  });
});

app.post('/order', upload.any(), (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    const body = req.body || {};
    if (!safeText(body.fullName) || !safeText(body.phone)) {
      cleanupFiles(files);
      return res.redirect('/?error=' + encodeURIComponent('Укажи имя и телефон'));
    }
    const formatConfigs = parseFormatConfigs(body.formatsJson);
    const usedFormats = formatConfigs.filter((item) => item.fileCount > 0 || item.filesExpected);
    if (!usedFormats.length || !files.length) {
      cleanupFiles(files);
      return res.redirect('/?error=' + encodeURIComponent('Добавь файлы хотя бы в один формат'));
    }
    const orders = readOrders();
    const order = buildOrder(body, files, formatConfigs, orders);
    orders.unshift(order);
    writeOrders(orders);
    return res.redirect('/?success=1');
  } catch (error) {
    console.error('Order create error:', error);
    cleanupFiles(files);
    return res.redirect('/?error=' + encodeURIComponent('Не удалось отправить заказ'));
  }
});

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin-login', { error: '' });
});
app.post('/admin/login', (req, res) => {
  if (String(req.body.password || '') !== ADMIN_PASSWORD) return res.status(401).render('admin-login', { error: 'Неверный пароль' });
  req.session.admin = true;
  res.redirect('/admin');
});
app.post('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin', requireAdmin, (req, res) => {
  const allOrders = readOrders();
  const search = safeText(req.query.search).toLowerCase();
  const status = safeText(req.query.status);
  const orders = allOrders.filter((order) => {
    const byStatus = !status || order.status === status;
    const bySearch = !search || [order.id, order.customer.phone, order.customer.fullName].join(' ').toLowerCase().includes(search);
    return byStatus && bySearch;
  });
  res.render('admin', { orders, activeSearch: req.query.search || '', activeStatus: status, fillLabels: Object.fromEntries(fillOptions.map((i) => [i.value, i.label])) });
});

app.post('/admin/order/:id/status', requireAdmin, (req, res) => {
  const orders = readOrders();
  const order = orders.find((item) => item.id === req.params.id);
  const nextStatus = safeText(req.body.status);
  if (!order) return res.status(404).send('Заказ не найден');
  if (!statuses.includes(nextStatus)) return res.status(400).send('Неверный статус');
  order.status = nextStatus;
  order.updatedAt = new Date().toISOString();
  order.adminNote = safeText(req.body.adminNote);
  writeOrders(orders);
  res.redirect('/admin');
});

app.get('/admin/order/:id/download-all', requireAdmin, (req, res) => {
  const order = readOrders().find((item) => item.id === req.params.id);
  if (!order) return res.status(404).send('Заказ не найден');
  const zip = new AdmZip();
  for (const [index, file] of (order.files || []).entries()) {
    const absolutePath = path.join(UPLOADS_DIR, file.relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    const ext = path.extname(file.originalName || file.storedName || '');
    const pretty = sanitizeFilename(`${file.targetFormat || 'A4'} ${file.printTypeLabel || ''} ${file.copiesLabel || ''} ${file.pagesLabel || ''}`.trim()).replace(/_/g, ' ');
    zip.addLocalFile(absolutePath, '', `${String(index + 1).padStart(2, '0')} ${pretty}${ext}`);
  }
  const buffer = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${order.id}.zip"`);
  res.send(buffer);
});

app.get('/uploads/*', requireAdmin, (req, res) => {
  const requestedPath = req.params[0] || '';
  const normalizedPath = path.normalize(requestedPath).replace(/^([.][.][/\\])+/, '');
  const absolutePath = path.join(UPLOADS_DIR, normalizedPath);
  if (!absolutePath.startsWith(UPLOADS_DIR)) return res.status(403).send('Доступ запрещен');
  if (!fs.existsSync(absolutePath)) return res.status(404).send('Файл не найден');
  res.sendFile(absolutePath);
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const message = err && err.message ? err.message : 'Ошибка сервера';
  if (req.path.startsWith('/admin')) return res.status(500).send(message);
  res.redirect('/?error=' + encodeURIComponent(message));
});

app.listen(PORT, () => console.log(`Copycenter site started on http://0.0.0.0:${PORT}`));

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

function parseFormatConfigs(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '[]')); } catch { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => paperOptions.includes(item.format)).map((item) => ({
    format: item.format,
    printType: item.printType === 'color' ? 'color' : 'bw',
    fillScale: fillOptions.some((f) => f.value === item.fillScale) ? item.fillScale : 'scale1',
    sides: item.sides === 'double' ? 'double' : 'single',
    copies: normalizePositiveInt(item.copies, 1),
    pages: normalizePositiveInt(item.pages, 1),
    comment: safeText(item.comment),
    fileCount: normalizePositiveInt(item.fileCount, 0),
    fileCountManual: item.fileCountManual === true,
    filesExpected: item.filesExpected === true,
  }));
}

function buildOrder(body, files, formatConfigs, existingOrders) {
  const nextNumber = getNextOrderNumber(existingOrders);
  const filesByFormat = Object.fromEntries(paperOptions.map((item) => [item, 0]));
  const filesMap = new Map(formatConfigs.map((cfg) => [cfg.format, []]));
  for (const file of files) {
    const targetFormat = extractFormatFromField(file.fieldname);
    if (!targetFormat) continue;
    if (!filesMap.has(targetFormat)) filesMap.set(targetFormat, []);
    filesMap.get(targetFormat).push(file);
    filesByFormat[targetFormat] += 1;
  }

  const formatOrders = formatConfigs.filter((cfg) => (filesMap.get(cfg.format) || []).length > 0).map((cfg) => {
    const price = estimateRowPrice(cfg);
    return {
      ...cfg,
      fileCount: (filesMap.get(cfg.format) || []).length,
      total: price.total,
      totalLabel: price.totalLabel,
      priceNote: price.note,
      printTypeLabel: cfg.printType === 'bw' ? 'ЧБ' : 'Цвет',
      copiesLabel: `${cfg.copies} коп.`,
      pagesLabel: cfg.pages > 1 ? `листы 1-${cfg.pages}` : '1 лист',
    };
  });

  const preparedFiles = [];
  for (const row of formatOrders) {
    for (const file of filesMap.get(row.format) || []) {
      preparedFiles.push({
        originalName: file.originalname,
        storedName: path.basename(file.path),
        relativePath: path.relative(UPLOADS_DIR, file.path).split(path.sep).join('/'),
        size: file.size,
        mimeType: file.mimetype || '',
        targetFormat: row.format,
        printTypeLabel: row.printTypeLabel,
        copiesLabel: row.copiesLabel,
        pagesLabel: row.pagesLabel,
      });
    }
  }

  const total = formatOrders.reduce((sum, row) => sum + (row.total || 0), 0);
  return {
    id: `LDG-${nextNumber}`,
    numericId: nextNumber,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'Новый',
    adminNote: '',
    customer: {
      fullName: safeText(body.fullName),
      phone: safeText(body.phone),
      email: safeText(body.email),
      address: safeText(body.address),
      deliveryType: safeText(body.deliveryType) === 'delivery' ? 'delivery' : 'pickup',
      comment: safeText(body.comment),
    },
    print: {
      total,
      totalLabel: total ? `${formatNumber(total)} ₽` : 'По запросу',
      filesByFormat,
      formatOrders,
    },
    files: preparedFiles,
  };
}

function estimateRowPrice(row) {
  const base = priceTable[row.printType]?.[row.fillScale]?.[row.format] ?? null;
  if (base == null) return { total: 0, totalLabel: 'По запросу', note: 'Цена уточняется' };
  const sideMultiplier = row.sides === 'double' ? 1.8 : 1;
  const total = Math.round(base * row.copies * row.pages * sideMultiplier);
  return { total, totalLabel: `${formatNumber(total)} ₽`, note: '' };
}

function getNextOrderNumber(orders) {
  const maxExisting = orders.reduce((max, item) => Math.max(max, Number(item.numericId) || 1023), 1023);
  return maxExisting + 1;
}

function readOrders() {
  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8').trim();
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Read orders error:', error);
    return [];
  }
}
function writeOrders(orders) { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8'); }
function ensureOrdersFile() { if (!fs.existsSync(ORDERS_FILE) || !fs.readFileSync(ORDERS_FILE, 'utf8').trim()) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8'); }
function ensureDir(target) { if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true }); }
function extractFormatFromField(fieldName) { const match = String(fieldName || '').match(/^files_(A[0-5])$/i); return match ? match[1].toUpperCase() : ''; }
function sanitizeFilename(name) { return String(name || 'file').replace(/[^a-zA-Zа-яА-Я0-9._ -]+/g, '_').replace(/_+/g, '_').slice(0, 120); }
function normalizePositiveInt(value, fallback) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) return fallback; return Math.floor(parsed); }
function safeText(value) { return String(value || '').trim().slice(0, 5000); }
function cleanupFiles(files) { for (const file of files || []) { try { if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {} } }
function formatNumber(value) { return new Intl.NumberFormat('ru-RU').format(Number(value) || 0); }

// ============================================================
// Онлайн-прайс для партнёров
// Что здесь есть: вход с расшифровкой, показ прайса, выбор
// количества, подсчёт итогов, черновик заказа и выгрузка Excel.
// ============================================================

const DRAFT_PREFIX = "bm-price-draft:";

const state = {
  login: "",
  partner: "",
  meta: {},
  price: [],
  order: new Map(), // id позиции -> число упаковок
  search: "",
  section: "",
};

const money = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const whole = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
});

const $ = (id) => document.getElementById(id);

const loginView = $("loginView");
const catalogView = $("catalogView");
const loginForm = $("loginForm");
const loginInput = $("loginInput");
const passwordInput = $("passwordInput");
const loginButton = $("loginButton");
const loginError = $("loginError");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------- Шифрование ----------

function normalizeLogin(value) {
  return value.trim().toLowerCase();
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function decryptPayload(blob, password) {
  const salt = base64ToBytes(blob.kdf.salt);
  const iv = base64ToBytes(blob.cipher.iv);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: blob.kdf.iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(blob.ciphertext)
  );

  return JSON.parse(decoder.decode(plain));
}

// ---------- Вход ----------

function showLoginError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

function hideLoginError() {
  loginError.textContent = "";
  loginError.hidden = true;
}

function setLoginBusy(busy) {
  loginButton.disabled = busy;
  loginButton.textContent = busy ? "Проверяем…" : "Войти";
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideLoginError();

  const login = normalizeLogin(loginInput.value);
  const password = passwordInput.value;

  if (!login || !password) {
    showLoginError("Введите логин и пароль.");
    return;
  }

  if (!(window.crypto && window.crypto.subtle)) {
    showLoginError(
      "Этот браузер не умеет защищённый вход. Откройте страницу в свежем Chrome, Safari или Firefox."
    );
    return;
  }

  setLoginBusy(true);
  try {
    const hash = await sha256Hex(login);
    const response = await fetch(`data/p-${hash.slice(0, 16)}.json`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("not-found");
    }

    const blob = await response.json();
    const data = await decryptPayload(blob, password);
    enterCatalog(login, data);
  } catch (error) {
    // Одно и то же сообщение и для неверного логина, и для неверного пароля
    showLoginError("Неверный логин или пароль.");
    passwordInput.select();
  } finally {
    setLoginBusy(false);
  }
});

function enterCatalog(login, data) {
  state.login = login;
  state.partner = String(data.partner || "Партнёр");
  state.meta = data.meta || {};
  state.price = Array.isArray(data.price) ? data.price : [];
  state.order = new Map();
  state.search = "";
  state.section = "";

  restoreDraft();

  loginView.hidden = true;
  catalogView.hidden = false;

  $("partnerName").textContent = state.partner;
  $("priceDate").textContent = state.meta.date ? `Прайс на ${state.meta.date}` : "";

  passwordInput.value = "";
  $("searchInput").value = "";
  $("sectionSelect").value = "";

  buildSectionOptions();
  renderPrice();
  updateTotals();
  $("searchInput").focus();
}

// ---------- Прайс ----------

function prettify(section) {
  // "1_Разливное пиво" -> "1. Разливное пиво"
  return String(section || "").replace(/^(\d+)_/, "$1. ");
}

function buildSectionOptions() {
  const select = $("sectionSelect");
  const sections = [];

  for (const item of state.price) {
    if (item.section && !sections.includes(item.section)) {
      sections.push(item.section);
    }
  }

  select.replaceChildren();

  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Все разделы";
  select.append(all);

  for (const section of sections) {
    const option = document.createElement("option");
    option.value = section;
    option.textContent = prettify(section);
    select.append(option);
  }
}

function renderPrice() {
  const list = $("priceList");
  list.replaceChildren();

  const query = state.search;
  const sectionFilter = state.section;

  const visible = state.price.filter((item) => {
    if (sectionFilter && item.section !== sectionFilter) return false;
    if (query && !String(item.name).toLowerCase().includes(query)) return false;
    return true;
  });

  $("emptyMessage").hidden = visible.length > 0;
  if (visible.length === 0) return;

  // Группируем по разделу и подразделу, сохраняя порядок прайса
  const groups = new Map();
  for (const item of visible) {
    const section = item.section || "Без раздела";
    const subsection = item.subsection || "";

    if (!groups.has(section)) groups.set(section, new Map());
    const subs = groups.get(section);
    if (!subs.has(subsection)) subs.set(subsection, []);
    subs.get(subsection).push(item);
  }

  const fragment = document.createDocumentFragment();

  for (const [section, subs] of groups) {
    const group = document.createElement("section");
    group.className = "group";

    const title = document.createElement("h2");
    title.className = "group__section";
    title.textContent = prettify(section);
    group.append(title);

    for (const [subsection, items] of subs) {
      const block = document.createElement("div");
      block.className = "subsection";

      if (subsection) {
        const subTitle = document.createElement("h3");
        subTitle.className = "subsection__title";
        subTitle.textContent = subsection;
        block.append(subTitle);
      }

      const rows = document.createElement("div");
      rows.className = "rows";
      for (const item of items) rows.append(createRow(item));
      block.append(rows);
      group.append(block);
    }

    fragment.append(group);
  }

  list.append(fragment);
}

function readQuantity(input) {
  // Целое число от 0 до 9999: защита от дробей, минуса и случайных гигантских чисел
  const value = Math.floor(Number(input.value) || 0);
  return Math.min(9999, Math.max(0, value));
}

function createRow(item) {
  const packs = state.order.get(item.id) || 0;

  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = String(item.id);
  row.classList.toggle("is-selected", packs > 0);

  const name = document.createElement("div");
  name.className = "row__name";

  const title = document.createElement("span");
  title.className = "row__title";
  title.textContent = item.name;

  const meta = document.createElement("span");
  meta.className = "row__meta";
  meta.textContent = `${whole.format(item.pack_qty)} шт в упаковке · ${money.format(item.price_unit)} ₽/шт`;
  name.append(title, meta);

  const price = document.createElement("div");
  price.className = "row__price";
  price.textContent = money.format(item.price_pack);
  const priceHint = document.createElement("span");
  priceHint.textContent = "₽ за упаковку";
  price.append(priceHint);

  const qty = document.createElement("div");
  qty.className = "row__qty";

  const minus = document.createElement("button");
  minus.type = "button";
  minus.className = "qty__step";
  minus.textContent = "−";
  minus.setAttribute("aria-label", `Убрать упаковку: ${item.name}`);

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.inputMode = "numeric";
  input.className = "qty__input";
  input.value = packs > 0 ? String(packs) : "";
  input.setAttribute("aria-label", `Упаковок: ${item.name}`);

  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "qty__step";
  plus.textContent = "+";
  plus.setAttribute("aria-label", `Добавить упаковку: ${item.name}`);

  input.addEventListener("input", () => applyQuantity(item, input));
  minus.addEventListener("click", () => {
    input.value = String(Math.max(0, readQuantity(input) - 1));
    applyQuantity(item, input);
  });
  plus.addEventListener("click", () => {
    input.value = String(readQuantity(input) + 1);
    applyQuantity(item, input);
  });

  qty.append(minus, input, plus);

  const sum = document.createElement("div");
  sum.className = "row__sum";

  row.append(name, price, qty, sum);
  updateRowSum(item, row);

  return row;
}

function applyQuantity(item, input) {
  const packs = readQuantity(input);

  // Не даём оставить дробь или минус: приводим поле к целому числу
  if (input.value !== "" && Number(input.value) !== packs) {
    input.value = packs > 0 ? String(packs) : "";
  }

  if (packs > 0) state.order.set(item.id, packs);
  else state.order.delete(item.id);

  const row = input.closest(".row");
  if (row) {
    row.classList.toggle("is-selected", packs > 0);
    updateRowSum(item, row);
  }

  updateTotals();
  saveDraft();
}

function updateRowSum(item, row) {
  const box = row.querySelector(".row__sum");
  if (!box) return;

  box.replaceChildren();

  const packs = state.order.get(item.id) || 0;
  if (packs <= 0) return;

  // Считаем в копейках, чтобы не было хвостов вида 137.08000000000001
  const sumKopecks = packs * Math.round(item.price_pack * 100);

  const total = document.createElement("b");
  total.textContent = `${money.format(sumKopecks / 100)} ₽`;

  const pieces = document.createElement("span");
  pieces.textContent = `${whole.format(packs * item.pack_qty)} шт`;

  box.append(total, pieces);
}

function updateTotals() {
  let positions = 0;
  let packs = 0;
  let pieces = 0;
  let totalKopecks = 0;

  for (const item of state.price) {
    const qty = state.order.get(item.id) || 0;
    if (qty <= 0) continue;

    positions += 1;
    packs += qty;
    pieces += qty * item.pack_qty;
    totalKopecks += qty * Math.round(item.price_pack * 100);
  }

  $("statPositions").textContent = whole.format(positions);
  $("statPacks").textContent = whole.format(packs);
  $("statPieces").textContent = whole.format(pieces);
  $("statTotal").textContent = `${money.format(totalKopecks / 100)} ₽`;
  $("excelButton").disabled = positions === 0;
}

// ---------- Поиск и фильтр ----------

let searchTimer = 0;

$("searchInput").addEventListener("input", (event) => {
  const value = event.target.value.trim().toLowerCase();
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.search = value;
    renderPrice();
  }, 120);
});

$("sectionSelect").addEventListener("change", (event) => {
  state.section = event.target.value;
  renderPrice();
});

// ---------- Черновик заказа ----------

function saveDraft() {
  try {
    const data = {};
    for (const [id, packs] of state.order) {
      if (packs > 0) data[id] = packs;
    }
    localStorage.setItem(DRAFT_PREFIX + state.login, JSON.stringify(data));
  } catch (error) {
    // Некоторые браузеры запрещают localStorage — тогда просто не сохраняем
  }
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + state.login);
    if (!raw) return;

    const data = JSON.parse(raw);
    const known = new Set(state.price.map((item) => item.id));

    for (const [key, value] of Object.entries(data)) {
      const id = Number(key);
      const packs = Math.max(0, Math.floor(Number(value) || 0));
      if (known.has(id) && packs > 0) {
        state.order.set(id, packs);
      }
    }
  } catch (error) {
    // Испорченный черновик просто игнорируем
  }
}

// ---------- Очистка и выход ----------

$("clearButton").addEventListener("click", () => {
  if (state.order.size === 0) return;
  if (!window.confirm("Убрать все отмеченные позиции из заказа?")) return;

  state.order.clear();
  try {
    localStorage.removeItem(DRAFT_PREFIX + state.login);
  } catch (error) {
    // Если localStorage запрещён — просто чистим заказ на экране
  }
  renderPrice();
  updateTotals();
});

$("logoutButton").addEventListener("click", () => {
  state.login = "";
  state.partner = "";
  state.meta = {};
  state.price = [];
  state.order = new Map();
  state.search = "";
  state.section = "";

  catalogView.hidden = true;
  loginView.hidden = false;

  // Убираем прайс из страницы, чтобы после выхода названия и цены не лежали в скрытом DOM
  $("priceList").replaceChildren();
  $("emptyMessage").hidden = true;
  $("searchInput").value = "";
  $("sectionSelect").value = "";
  updateTotals();

  loginInput.value = "";
  passwordInput.value = "";
  hideLoginError();
  loginInput.focus();
});

// ---------- Excel-заказ ----------

const ORDER_HEADERS = [
  "№",
  "Наименование",
  "Раздел",
  "Подраздел",
  "Цена за шт",
  "Цена упак",
  "Кол-во в упак",
  "Кол-во упак (заказ)",
  "Кол-во шт",
  "Сумма",
];

function selectedRows() {
  return state.price
    .filter((item) => (state.order.get(item.id) || 0) > 0)
    .map((item) => ({ item, packs: state.order.get(item.id) }));
}

function managerLine() {
  const manager = state.meta.manager || "";
  const phone = state.meta.phone || "";
  if (manager && phone) return `Менеджер: ${manager}, тел. ${phone}`;
  if (manager) return `Менеджер: ${manager}`;
  return "";
}

function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function makeFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
  const partner = state.partner
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "партнёр";

  return `Заказ — ${partner} — ${date}.xlsx`;
}

function buildOrderWorkbook() {
  const rows = selectedRows();

  const data = [];
  data.push(["ЗАКАЗ"]);
  data.push([`Партнёр: ${state.partner}`]);
  data.push([`Дата и время: ${formatDateTime(new Date())}`]);
  data.push([state.meta.delivery || ""]);
  data.push([managerLine()]);
  data.push([]);
  data.push(ORDER_HEADERS.slice());

  let packsTotal = 0;
  let piecesTotal = 0;
  let sumKopecksTotal = 0;

  for (const { item, packs } of rows) {
    const unitKopecks = Math.round(item.price_unit * 100);
    const packKopecks = Math.round(item.price_pack * 100);
    const pieces = packs * item.pack_qty;
    const sumKopecks = packs * packKopecks;

    packsTotal += packs;
    piecesTotal += pieces;
    sumKopecksTotal += sumKopecks;

    data.push([
      item.id,
      item.name,
      item.section, // в Excel — как в прайсе, без украшений
      item.subsection,
      unitKopecks / 100,
      packKopecks / 100,
      item.pack_qty,
      packs,
      pieces,
      sumKopecks / 100,
    ]);
  }

  data.push(["", "ИТОГО", "", "", "", "", "", packsTotal, piecesTotal, sumKopecksTotal / 100]);

  const sheet = XLSX.utils.aoa_to_sheet(data);

  sheet["!cols"] = [
    { wch: 5 },
    { wch: 46 },
    { wch: 22 },
    { wch: 18 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 11 },
    { wch: 14 },
  ];

  // Числовые форматы: деньги с копейками, количества — целые.
  // Строка 8 — первая строка данных, последняя — итоговая.
  const firstDataRow = 8;
  const lastRow = firstDataRow + rows.length;
  for (let r = firstDataRow; r <= lastRow; r += 1) {
    for (const col of ["E", "F", "J"]) {
      const cell = sheet[`${col}${r}`];
      if (cell) cell.z = "#,##0.00";
    }
    for (const col of ["G", "H", "I"]) {
      const cell = sheet[`${col}${r}`];
      if (cell) cell.z = "0";
    }
  }

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Заказ");
  return book;
}

let downloadTimer = 0;

$("excelButton").addEventListener("click", () => {
  if (typeof XLSX === "undefined") {
    window.alert("Не загрузилась библиотека для Excel. Обновите страницу и попробуйте снова.");
    return;
  }
  if (selectedRows().length === 0) return;

  const button = $("excelButton");

  try {
    XLSX.writeFile(buildOrderWorkbook(), makeFilename(), { compression: true });

    // Короткое подтверждение: партнёру понятно, что файл уже у него
    button.textContent = "Файл скачан";
    window.clearTimeout(downloadTimer);
    downloadTimer = window.setTimeout(() => {
      button.textContent = "Скачать Excel";
    }, 2500);
  } catch (error) {
    window.alert("Не удалось собрать файл. Попробуйте ещё раз или сообщите менеджеру.");
  }
});

// ---------- Старт ----------

// Шифрование в браузере работает только на localhost или https.
// Двойной щелчок по index.html (адрес file://) не подойдёт — предупреждаем сразу.
if (location.protocol === "file:" || !window.isSecureContext) {
  showLoginError(
    "Откройте сайт по адресу http://localhost или по защищённой ссылке https. Двойной щелчок по файлу не подойдёт."
  );
  loginButton.disabled = true;
} else {
  loginInput.focus();
}

// «Пульт» для проверки из консоли и автотестов
window.priceApp = {
  state,
  selectedRows,
  buildOrderWorkbook,
};

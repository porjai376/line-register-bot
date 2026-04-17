require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const PORT = process.env.PORT || 3000;
const ADMIN_USER_IDS = (process.env.LINE_ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ✅ ใช้ Render Persistent Disk
const PERSIST_DIR = process.env.PERSIST_DIR || '/var/data';
const DATA_DIR = path.join(PERSIST_DIR, 'data');
const UPLOAD_DIR = path.join(PERSIST_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function initialDb() {
  return {
    users: {},
    processedEvents: {},
    requests: {},
  };
}

const db = readJson(DB_FILE, initialDb());
if (!db.users) db.users = {};
if (!db.processedEvents) db.processedEvents = {};
if (!db.requests) db.requests = {};
writeJson(DB_FILE, db);

function saveDb() {
  writeJson(DB_FILE, db);
}

function formatThaiDateTime(dateLike) {
  const d = new Date(dateLike);
  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function addDays(dateLike, days) {
  const d = new Date(dateLike);
  d.setDate(d.getDate() + days);
  return d;
}

function isExpired(user) {
  if (!user || !user.expireAt) return true;
  return new Date(user.expireAt).getTime() < Date.now();
}

function cleanupProcessedEvents() {
  const now = Date.now();
  const ttl = 24 * 60 * 60 * 1000;
  for (const [eventId, ts] of Object.entries(db.processedEvents)) {
    if (now - ts > ttl) delete db.processedEvents[eventId];
  }
}

function markEventProcessed(eventId) {
  cleanupProcessedEvents();
  db.processedEvents[eventId] = Date.now();
  saveDb();
}

function isEventProcessed(eventId) {
  cleanupProcessedEvents();
  return !!db.processedEvents[eventId];
}

function ensureUser(userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      userId,
      lineName: '',
      registerText: '',
      rank: '',
      fullName: '',
      position: '',
      department: '',
      phone: '',
      status: 'none', // none | waiting_card | pending | approved | rejected
      cardImagePath: '',
      registeredAt: null,
      approvedAt: null,
      expireAt: null,
      approvedDays: null,
      rejectedAt: null,
      flow: null,
      requestDraft: null,
    };
  }
  return db.users[userId];
}

async function getProfileSafe(userId) {
  try {
    const profile = await client.getProfile(userId);
    return profile;
  } catch {
    return null;
  }
}

function parseRegisterText(text) {
  if (!text || !text.startsWith('re#')) return null;
  const raw = text.slice(3).trim();
  const parts = raw.split('/').map((s) => s.trim());
  if (parts.length !== 5) return null;
  const [rank, fullName, position, department, phone] = parts;
  const cleanPhone = phone.replace(/\D/g, '');
  if (!rank || !fullName || !position || !department || cleanPhone.length < 9) return null;
  return {
    rank,
    fullName,
    position,
    department,
    phone: cleanPhone,
    raw,
  };
}

function parseAdminSendCommand(text) {
  if (!text || !text.startsWith('sendto#')) return null;

  const raw = text.slice(7).trim();
  const parts = raw.split('|');
  if (parts.length < 2) return null;

  const targetUserId = (parts[0] || '').trim();
  const messageText = parts.slice(1).join('|').trim();

  if (!targetUserId || !messageText) return null;

  return {
    targetUserId,
    messageText,
  };
}

function buildRegisterSuccessText(user) {
  return [
    'ลงทะเบียนเรียบร้อย✅',
    `เวลาลงทะเบียน: ${formatThaiDateTime(user.registeredAt)}`,
    'ข้อมูลที่ลงทะเบียน',
    `ยศ: ${user.rank}`,
    `ชื่อ-สกุล: ${user.fullName}`,
    `ตำแหน่ง: ${user.position}`,
    `สังกัด: ${user.department}`,
    `เบอร์โทร: ${user.phone}`,
    `UID: ${user.userId}`,
    `ชื่อ LINE: ${user.lineName || '-'}`,
    '📂กรุณาแนบบัตรข้าราชการ',
  ].join('\n');
}

function buildPendingCompleteText() {
  return [
    'ดำเนินการครบทุกขั้นตอนเรียบร้อย💡',
    'รอผู้ดูแลอนุมัติสิทธิ์การใช้งาน',
    'ตรวจสอบสิทธิ กดปุ่มเช็คสถานะ📅',
  ].join('\n');
}

function buildStatusFlex(user) {
  let statusText = 'ยังไม่ได้ลงทะเบียน';
  let extra = 'กรุณาส่งคำสั่ง re#ยศ/ชื่อ สกุล/ตำแหน่ง/สังกัด/เบอร์โทร';

  if (user) {
    if (user.status === 'waiting_card') {
      statusText = 'ลงทะเบียนแล้ว รอแนบบัตร';
      extra = 'กรุณาส่งภาพบัตรข้าราชการ';
    } else if (user.status === 'pending') {
      statusText = 'รอผู้ดูแลอนุมัติ';
      extra = `ลงทะเบียนเมื่อ ${formatThaiDateTime(user.registeredAt)}`;
    } else if (user.status === 'approved') {
      statusText = isExpired(user) ? 'สิทธิ์หมดอายุ' : 'อนุมัติแล้ว';
      extra = [
        `อนุมัติเมื่อ ${user.approvedAt ? formatThaiDateTime(user.approvedAt) : '-'}`,
        `หมดอายุ ${user.expireAt ? formatThaiDateTime(user.expireAt) : '-'}`,
      ].join('\n');
    } else if (user.status === 'rejected') {
      statusText = 'ไม่อนุมัติสิทธิ์';
      extra = user.rejectedAt ? `อัปเดตล่าสุด ${formatThaiDateTime(user.rejectedAt)}` : '-';
    }
  }

  return {
    type: 'flex',
    altText: 'สถานะการใช้งาน',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'เช็คสถานะสิทธิ์', weight: 'bold', size: 'xl' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `สถานะ: ${statusText}`, wrap: true, size: 'md', margin: 'md' },
          { type: 'text', text: extra, wrap: true, size: 'sm', color: '#666666' },
        ],
      },
    },
  };
}

function buildAdminApprovalFlex(user) {
  const durations = [30, 90, 120, 365];
  const buttons = durations.map((days) => ({
    type: 'button',
    style: 'primary',
    margin: 'sm',
    action: {
      type: 'postback',
      label: `อนุมัติ ${days} วัน`,
      data: `approve|${user.userId}|${days}`,
      displayText: `อนุมัติ ${days} วัน`,
    },
  }));

  buttons.push({
    type: 'button',
    style: 'secondary',
    margin: 'sm',
    action: {
      type: 'postback',
      label: 'ไม่อนุมัติสิทธิ์',
      data: `reject|${user.userId}`,
      displayText: 'ไม่อนุมัติสิทธิ์',
    },
  });

  return {
    type: 'flex',
    altText: 'มีผู้สมัครใหม่ รออนุมัติ',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '📥 ผู้สมัครใหม่', weight: 'bold', size: 'xl' },
          { type: 'text', text: `เวลาลงทะเบียน: ${formatThaiDateTime(user.registeredAt)}`, wrap: true, size: 'sm' },
          { type: 'text', text: `ยศ: ${user.rank}`, wrap: true, size: 'sm' },
          { type: 'text', text: `ชื่อ-สกุล: ${user.fullName}`, wrap: true, size: 'sm' },
          { type: 'text', text: `ตำแหน่ง: ${user.position}`, wrap: true, size: 'sm' },
          { type: 'text', text: `สังกัด: ${user.department}`, wrap: true, size: 'sm' },
          { type: 'text', text: `เบอร์โทร: ${user.phone}`, wrap: true, size: 'sm' },
          { type: 'text', text: `UID: ${user.userId}`, wrap: true, size: 'sm' },
          { type: 'text', text: `ชื่อ LINE: ${user.lineName || '-'}`, wrap: true, size: 'sm' },
          { type: 'text', text: `บัตร: ${user.cardImagePath || '-'}`, wrap: true, size: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: buttons,
      },
    },
  };
}

function buildCancelTemplate(title, text) {
  return {
    type: 'template',
    altText: title,
    template: {
      type: 'buttons',
      title,
      text,
      actions: [
        {
          type: 'message',
          label: '❌ ยกเลิก',
          text: 'ยกเลิก',
        },
      ],
    },
  };
}

function buildHelpFlex() {
  return {
    type: 'flex',
    altText: 'เมนูคำสั่งใช้งาน',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F172A',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '🔎 คำสั่งใช้งาน',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: 'เลือกดูคำสั่งที่ต้องการใช้งานได้ด้านล่าง',
            color: '#CBD5E1',
            size: 'sm',
            margin: 'md',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            cornerRadius: '12px',
            backgroundColor: '#F8FAFC',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '📂 ลงทะเบียน', weight: 'bold', size: 'md' },
              {
                type: 'text',
                text: 're#ยศ/ชื่อ สกุล/ตำแหน่ง/สังกัด/เบอร์โทร',
                size: 'sm',
                color: '#475569',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            cornerRadius: '12px',
            backgroundColor: '#F8FAFC',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '📅 เช็คสถานะ', weight: 'bold', size: 'md' },
              {
                type: 'text',
                text: 'เช็คสถานะ',
                size: 'sm',
                color: '#475569',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            cornerRadius: '12px',
            backgroundColor: '#F8FAFC',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '📶 คำขอข้อมูลสัญญาณ', weight: 'bold', size: 'md' },
              {
                type: 'text',
                text: 'base@',
                size: 'sm',
                color: '#475569',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            cornerRadius: '12px',
            backgroundColor: '#F8FAFC',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '🏦 คำขอข้อมูลธนาคารภายใน', weight: 'bold', size: 'md' },
              {
                type: 'text',
                text: 'bank@',
                size: 'sm',
                color: '#475569',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            cornerRadius: '12px',
            backgroundColor: '#F8FAFC',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '🧑‍💻 ดู UID ของตนเอง', weight: 'bold', size: 'md' },
              {
                type: 'text',
                text: 'myid',
                size: 'sm',
                color: '#475569',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            cornerRadius: '12px',
            backgroundColor: '#F8FAFC',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '❎ ยกเลิกขั้นตอนปัจจุบัน', weight: 'bold', size: 'md' },
              {
                type: 'text',
                text: 'ยกเลิก',
                size: 'sm',
                color: '#475569',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#2563EB',
            action: {
              type: 'message',
              label: '📅 เช็คสถานะ',
              text: 'เช็คสถานะ',
            },
          },
          {
            type: 'button',
            style: 'primary',
            color: '#059669',
            action: {
              type: 'message',
              label: '📶 base@',
              text: 'base@',
            },
            margin: 'sm',
          },
          {
            type: 'button',
            style: 'primary',
            color: '#D97706',
            action: {
              type: 'message',
              label: '🏦 bank@',
              text: 'bank@',
            },
            margin: 'sm',
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '🧑‍💻 ดู UID',
              text: 'myid',
            },
            margin: 'sm',
          },
        ],
      },
    },
  };
}

function buildSupportFlex() {
  return {
    type: 'flex',
    altText: 'รายการสนับสนุน',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          size: 'mega',
          hero: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '20px',
            backgroundColor: '#0F172A',
            contents: [
              {
                type: 'text',
                text: '📂 รายการสนับสนุน',
                color: '#FFFFFF',
                weight: 'bold',
                size: 'xl'
              },
              {
                type: 'text',
                text: 'ระบบตรวจสอบข้อมูลสัญญาณ',
                color: '#CBD5E1',
                size: 'sm',
                margin: 'md'
              }
            ]
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: 'ตรวจสอบเบส สด / นอน',
                weight: 'bold',
                size: 'lg',
                color: '#111827'
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '📗 AIS', size: 'sm', color: '#16A34A', flex: 1 },
                  { type: 'text', text: '📙 TRUE', size: 'sm', color: '#DC2626', flex: 1 },
                  { type: 'text', text: '📘 DTAC', size: 'sm', color: '#2563EB', flex: 1 }
                ]
              },
              { type: 'separator', margin: 'md' },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'md',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: 'แพ็กเกจ 6 เดือน', weight: 'bold', size: 'md', color: '#111827' },
                  { type: 'text', text: '8,000 THB', weight: 'bold', size: 'xl', color: '#059669' },
                  { type: 'text', text: 'ใช้งานได้ 8 รายการต่อวัน', size: 'sm', color: '#6B7280' }
                ]
              },
              { type: 'separator', margin: 'lg' },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'md',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: 'แพ็กเกจ 1 ปี', weight: 'bold', size: 'md', color: '#111827' },
                  { type: 'text', text: '15,000 THB', weight: 'bold', size: 'xl', color: '#059669' },
                  { type: 'text', text: 'ใช้งานได้ 15 รายการต่อวัน', size: 'sm', color: '#6B7280' }
                ]
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#16A34A',
                action: {
                  type: 'message',
                  label: 'เลือกแพ็กเกจนี้',
                  text: 'สนับสนุนแพ็กเกจตรวจสอบเบส'
                }
              }
            ]
          }
        },
        {
          type: 'bubble',
          size: 'mega',
          hero: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '20px',
            backgroundColor: '#7C2D12',
            contents: [
              {
                type: 'text',
                text: '🏦 บริการข้อมูลธนาคาร',
                color: '#FFFFFF',
                weight: 'bold',
                size: 'xl'
              },
              {
                type: 'text',
                text: 'ตรวจสอบ STM / พิกัดแอพธนาคารปักหัว',
                color: '#FED7AA',
                size: 'sm',
                margin: 'md',
                wrap: true
              }
            ]
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              { type: 'text', text: 'แพ็กเกจรายปี', weight: 'bold', size: 'md', color: '#111827' },
              { type: 'text', text: '20,000 THB', weight: 'bold', size: 'xxl', color: '#EA580C' },
              {
                type: 'text',
                text: 'รองรับงานตรวจสอบข้อมูลแบงค์ STM และพิกัดแอพธนาคารปักหัว',
                wrap: true,
                size: 'sm',
                color: '#6B7280'
              },
              { type: 'separator', margin: 'md' },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'md',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: 'เงื่อนไขแพ็กเกจ', weight: 'bold', size: 'sm', color: '#374151' },
                  { type: 'text', text: '• ระยะเวลาใช้งาน 1 ปี', size: 'sm', color: '#6B7280' },
                  { type: 'text', text: '• ใช้งานตามสิทธิ์ของระบบ', size: 'sm', color: '#6B7280' },
                  { type: 'text', text: '• สำหรับผู้ได้รับอนุมัติเท่านั้น', size: 'sm', color: '#6B7280' }
                ]
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#EA580C',
                action: {
                  type: 'message',
                  label: 'เลือกแพ็กเกจนี้',
                  text: 'สนับสนุนแพ็กเกจข้อมูลธนาคาร'
                }
              }
            ]
          }
        }
      ]
    }
  };
}

function newSafeRequestDraft(user) {
  return {
    requestId: `REQ-${Date.now()}`,
    createdAt: new Date().toISOString(),
    requesterName: user.fullName || user.lineName || '-',
    requesterUnit: user.department || '-',
    requesterPhone: user.phone || '-',
    referenceNumber: '',
    network: '',
    caseName: '',
    note: '',
    attachmentPath: '',
  };
}

function newBankRequestDraft(user) {
  return {
    requestId: `BANK-${Date.now()}`,
    createdAt: new Date().toISOString(),
    requesterName: user.fullName || user.lineName || '-',
    requesterUnit: user.department || '-',
    requesterPhone: user.phone || '-',
    referenceNumber: '',
    bankName: '',
    dateRange: '',
    caseName: '',
    note: '',
    attachmentPath: '',
  };
}

function normalizeNetwork(text) {
  const raw = String(text || '').trim().toUpperCase();
  if (['AIS', 'TRUE', 'DTAC', 'NT'].includes(raw)) return raw;
  return null;
}

function startSafeRequestFlow(user) {
  user.flow = 'safe_request_reference';
  user.requestDraft = newSafeRequestDraft(user);
  saveDb();
}

function startBankRequestFlow(user) {
  user.flow = 'bank_request_reference';
  user.requestDraft = newBankRequestDraft(user);
  saveDb();
}

function clearFlow(user) {
  user.flow = null;
  user.requestDraft = null;
  saveDb();
}

function buildRequestSummaryText(user) {
  const req = user.requestDraft;
  return [
    '📥 มีคำขอใหม่',
    `เวลา: ${formatThaiDateTime(req.createdAt)}`,
    `เลขคำขอ: ${req.requestId}`,
    `ผู้ส่ง: ${user.lineName || '-'}`,
    `UID: ${user.userId}`,
    `ผู้ยื่นคำขอ: ${req.requesterName}`,
    `หน่วยงาน: ${req.requesterUnit}`,
    `เบอร์ผู้ยื่น: ${req.requesterPhone}`,
    `เบอร์เป้าหมาย: ${req.referenceNumber}`,
    `เครือข่าย: ${req.network}`,
    `ชื่อเคส/เหตุ: ${req.caseName}`,
    `หมายเหตุ: ${req.note || '-'}`,
  ].join('\n');
}

function buildBankRequestSummaryText(user) {
  const req = user.requestDraft;
  return [
    '📥 มีคำขอข้อมูลธนาคารภายใน',
    `เวลา: ${formatThaiDateTime(req.createdAt)}`,
    `เลขคำขอ: ${req.requestId}`,
    `ผู้ส่ง: ${user.lineName || '-'}`,
    `UID: ${user.userId}`,
    `ผู้ยื่นคำขอ: ${req.requesterName}`,
    `หน่วยงาน: ${req.requesterUnit}`,
    `เบอร์ผู้ยื่น: ${req.requesterPhone}`,
    `เลขอ้างอิงที่ตรวจสอบ: ${req.referenceNumber}`,
    `ธนาคาร: ${req.bankName}`,
    `ช่วงวันที่ต้องการข้อมูล: ${req.dateRange}`,
    `ชื่อเคส: ${req.caseName}`,
    `รายละเอียดประกอบ: ${req.note || '-'}`,
  ].join('\n');
}

async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

async function replyMessages(replyToken, messages) {
  return client.replyMessage({
    replyToken,
    messages,
  });
}

async function pushText(to, text) {
  return client.pushMessage({
    to,
    messages: [{ type: 'text', text }],
  });
}

async function notifyAdmins(messages) {
  for (const adminId of ADMIN_USER_IDS) {
    try {
      await client.pushMessage({ to: adminId, messages });
    } catch (err) {
      console.error('notify admin failed:', adminId, err?.message || err);
    }
  }
}

async function downloadContent(messageId, savePath) {
  const res = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    responseType: 'stream',
    headers: {
      Authorization: `Bearer ${config.channelAccessToken}`,
    },
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(savePath);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function handleRegisterCommand(event, text) {
  const userId = event.source.userId;
  const parsed = parseRegisterText(text);
  if (!parsed) {
    return replyText(
      event.replyToken,
      'รูปแบบไม่ถูกต้อง\nกรุณาพิมพ์ดังนี้\nre#ยศ/ชื่อ สกุล/ตำแหน่ง/สังกัด/เบอร์โทร\nตัวอย่าง\nre#ร.ต.อ./ทดสอบ ระบบ/รองสว.สส./สภ.เมืองอ่างทอง/0812345678'
    );
  }

  const user = ensureUser(userId);
  const profile = await getProfileSafe(userId);
  user.lineName = profile?.displayName || user.lineName || '';
  user.rank = parsed.rank;
  user.fullName = parsed.fullName;
  user.position = parsed.position;
  user.department = parsed.department;
  user.phone = parsed.phone;
  user.registerText = parsed.raw;
  user.registeredAt = new Date().toISOString();
  user.cardImagePath = '';
  user.approvedAt = null;
  user.expireAt = null;
  user.approvedDays = null;
  user.rejectedAt = null;
  user.status = 'waiting_card';
  user.flow = null;
  user.requestDraft = null;
  saveDb();

  const statusButton = {
    type: 'template',
    altText: 'เช็คสถานะสิทธิ์',
    template: {
      type: 'buttons',
      title: 'ลงทะเบียนสำเร็จ',
      text: 'กรุณาแนบบัตรข้าราชการเพื่อส่งคำขออนุมัติ',
      actions: [
        {
          type: 'message',
          label: 'เช็คสถานะ📅',
          text: 'เช็คสถานะ',
        },
      ],
    },
  };

  return replyMessages(event.replyToken, [
    { type: 'text', text: buildRegisterSuccessText(user) },
    statusButton,
  ]);
}

async function handleRegistrationCardUpload(event, user) {
  const filename = `${user.userId}_${Date.now()}.jpg`;
  const savePath = path.join(UPLOAD_DIR, filename);
  await downloadContent(event.message.id, savePath);

  user.cardImagePath = savePath;
  user.status = 'pending';
  saveDb();

  const statusButton = {
    type: 'template',
    altText: 'เช็คสถานะสิทธิ์',
    template: {
      type: 'buttons',
      title: 'ส่งเอกสารสำเร็จ',
      text: 'ตรวจสอบสถานะได้จากปุ่มด้านล่าง',
      actions: [
        {
          type: 'message',
          label: 'เช็คสถานะ📅',
          text: 'เช็คสถานะ',
        },
      ],
    },
  };

  await notifyAdmins([
    buildAdminApprovalFlex(user),
    {
      type: 'image',
      originalContentUrl: `${process.env.BASE_URL}/files/${filename}`,
      previewImageUrl: `${process.env.BASE_URL}/files/${filename}`,
    },
  ]);

  return replyMessages(event.replyToken, [
    { type: 'text', text: buildPendingCompleteText() },
    statusButton,
  ]);
}

async function handleSafeRequestImageUpload(event, user) {
  const req = user.requestDraft;
  if (!req) {
    clearFlow(user);
    return replyText(event.replyToken, 'ไม่พบคำขอที่กำลังทำรายการ');
  }

  const filename = `req_${user.userId}_${Date.now()}.jpg`;
  const savePath = path.join(UPLOAD_DIR, filename);
  await downloadContent(event.message.id, savePath);

  req.attachmentPath = savePath;
  db.requests[req.requestId] = {
    ...req,
    userId: user.userId,
    lineName: user.lineName || '-',
    requestType: 'safe_request',
    status: 'submitted',
    submittedAt: new Date().toISOString(),
  };
  saveDb();

  await notifyAdmins([
    { type: 'text', text: buildRequestSummaryText(user) },
    {
      type: 'image',
      originalContentUrl: `${process.env.BASE_URL}/files/${filename}`,
      previewImageUrl: `${process.env.BASE_URL}/files/${filename}`,
    },
  ]);

  clearFlow(user);

  return replyText(
    event.replyToken,
    'รับคำขอเรียบร้อย✅\nรอผลตรวจสอบสักครู่ตามลำดับ📂'
  );
}

async function handleBankRequestImageUpload(event, user) {
  const req = user.requestDraft;
  if (!req) {
    clearFlow(user);
    return replyText(event.replyToken, 'ไม่พบคำขอที่กำลังทำรายการ');
  }

  const filename = `bank_${user.userId}_${Date.now()}.jpg`;
  const savePath = path.join(UPLOAD_DIR, filename);
  await downloadContent(event.message.id, savePath);

  req.attachmentPath = savePath;
  db.requests[req.requestId] = {
    ...req,
    userId: user.userId,
    lineName: user.lineName || '-',
    requestType: 'bank_request_internal',
    status: 'submitted',
    submittedAt: new Date().toISOString(),
  };
  saveDb();

  await notifyAdmins([
    { type: 'text', text: buildBankRequestSummaryText(user) },
    {
      type: 'image',
      originalContentUrl: `${process.env.BASE_URL}/files/${filename}`,
      previewImageUrl: `${process.env.BASE_URL}/files/${filename}`,
    },
  ]);

  clearFlow(user);

  return replyText(
    event.replyToken,
    'รับคำขอข้อมูลธนาคารเรียบร้อย✅\nระบบได้สรุปและส่งให้แอดมินแล้ว'
  );
}

async function handleStatusCheck(event) {
  const userId = event.source.userId;
  const user = db.users[userId];
  return replyMessages(event.replyToken, [buildStatusFlex(user)]);
}

async function handleAdminSendMessage(event, text) {
  const actorId = event.source.userId;

  if (!ADMIN_USER_IDS.includes(actorId)) {
    return replyText(event.replyToken, 'คำสั่งนี้สำหรับแอดมินเท่านั้น');
  }

  const parsed = parseAdminSendCommand(text);
  if (!parsed) {
    return replyText(
      event.replyToken,
      'รูปแบบไม่ถูกต้อง\nกรุณาพิมพ์:\nsendto#UID|ข้อความที่ต้องการส่ง'
    );
  }

  const { targetUserId, messageText } = parsed;

  try {
    await pushText(targetUserId, messageText);
    return replyText(
      event.replyToken,
      `ส่งข้อความเรียบร้อยแล้ว✅\nถึง UID: ${targetUserId}\nข้อความ: ${messageText}`
    );
  } catch (err) {
    console.error('admin send message failed:', err?.message || err);
    return replyText(
      event.replyToken,
      `ส่งข้อความไม่สำเร็จ❌\nUID: ${targetUserId}\nกรุณาตรวจสอบว่า UID ถูกต้องและผู้ใช้เคยเพิ่มเพื่อนบอทแล้ว`
    );
  }
}

async function handlePostback(event) {
  const actorId = event.source.userId;
  if (!ADMIN_USER_IDS.includes(actorId)) {
    return replyText(event.replyToken, 'ท่านต้องลงทะเบียนหรือได้รับการอนุมัติพิมพ์help');
  }

  const data = event.postback?.data || '';
  const [action, targetUserId, value] = data.split('|');
  const user = db.users[targetUserId];

  if (!user) {
    return replyText(event.replyToken, 'ไม่พบผู้ใช้งาน');
  }

  if (action === 'approve') {
    const days = Number(value || 0);
    if (![30, 90, 120, 365].includes(days)) {
      return replyText(event.replyToken, 'จำนวนวันไม่ถูกต้อง');
    }

    const approvedAt = new Date();
    const expireAt = addDays(approvedAt, days);
    user.status = 'approved';
    user.approvedAt = approvedAt.toISOString();
    user.expireAt = expireAt.toISOString();
    user.approvedDays = days;
    user.rejectedAt = null;
    saveDb();

    await pushText(
      targetUserId,
      [
        `อนุมัติสิทธิ์การใช้งาน ${days} วัน✅`,
        `วันที่อนุมัติ: ${formatThaiDateTime(user.approvedAt)}`,
        `วันหมดอายุ: ${formatThaiDateTime(user.expireAt)}`,
        'หลังจากนี้สามารถใช้งานเมนูที่ได้รับสิทธิ์ได้',
      ].join('\n')
    );

    return replyText(event.replyToken, `อนุมัติ ${days} วัน ให้ ${user.fullName} เรียบร้อยแล้ว`);
  }

  if (action === 'reject') {
    user.status = 'rejected';
    user.rejectedAt = new Date().toISOString();
    user.approvedAt = null;
    user.expireAt = null;
    user.approvedDays = null;
    saveDb();

    await pushText(
      targetUserId,
      [
        'ไม่อนุมัติสิทธิ์การใช้งาน',
        `อัปเดตเมื่อ: ${formatThaiDateTime(user.rejectedAt)}`,
        'กรุณาติดต่อผู้ดูแล หากต้องการยื่นข้อมูลใหม่',
      ].join('\n')
    );

    return replyText(event.replyToken, `ไม่อนุมัติสิทธิ์ให้ ${user.fullName} แล้ว`);
  }

  return replyText(event.replyToken, 'ไม่พบคำสั่ง');
}

function userCanUseBase(user) {
  return !!user && user.status === 'approved' && !isExpired(user);
}

async function handleBaseStart(event, user) {
  if (!userCanUseBase(user)) {
    return replyText(event.replyToken, '❌ เฉพาะสมาชิกที่อนุมัติแล้วและยังไม่หมดอายุ');
  }

  startSafeRequestFlow(user);
  return replyMessages(event.replyToken, [
    { type: 'text', text: '📂 ระบบแจ้งข้อมูลเคส\nกรุณาแจ้งหมายเลข10หลัก' },
    buildCancelTemplate('ระบบแจ้งข้อมูลเคส', 'กรุณาแจ้งหมายเลข10หลัก'),
  ]);
}

async function handleBankStart(event, user) {
  if (!userCanUseBase(user)) {
    return replyText(event.replyToken, '❌ เฉพาะสมาชิกที่อนุมัติแล้วและยังไม่หมดอายุ');
  }

  startBankRequestFlow(user);
  return replyMessages(event.replyToken, [
    { type: 'text', text: '🏦 ระบบคำขอข้อมูลธนาคาร\nกรุณาแจ้งหมายเลขอ้างอิงที่ต้องการตรวจสอบ' },
    buildCancelTemplate('คำขอข้อมูลธนาคาร', 'กรุณาแจ้งหมายเลขอ้างอิงที่ต้องการตรวจสอบ'),
  ]);
}

async function handleSafeRequestText(event, user, text) {
  if (text === 'ยกเลิก' || text.toLowerCase() === 'cancel') {
    clearFlow(user);
    return replyText(event.replyToken, 'ยกเลิกรายการเรียบร้อยแล้ว');
  }

  const req = user.requestDraft;
  if (!req) {
    clearFlow(user);
    return replyText(event.replyToken, 'ไม่พบรายการที่กำลังทำอยู่');
  }

  if (user.flow === 'safe_request_reference') {
    req.referenceNumber = text;
    user.flow = 'safe_request_network';
    saveDb();
    return replyText(event.replyToken, 'แจ้งเครือข่ายมือถือ เช่น AIS TRUE DTAC');
  }

  if (user.flow === 'safe_request_network') {
    const network = normalizeNetwork(text);
    if (!network) {
      return replyText(event.replyToken, 'กรุณาระบุเครือข่ายเป็น AIS / TRUE / DTAC / NT');
    }
    req.network = network;
    user.flow = 'safe_request_case_name';
    saveDb();
    return replyText(event.replyToken, 'แจ้งชื่อเคส/เหตุ');
  }

  if (user.flow === 'safe_request_case_name') {
    req.caseName = text;
    user.flow = 'safe_request_note';
    saveDb();
    return replyText(event.replyToken, 'แจ้งชื่อสกุลเป้า/เลข13หลักเป้า');
  }

  if (user.flow === 'safe_request_note') {
    req.note = text;
    user.flow = 'safe_request_attachment';
    saveDb();
    return replyText(event.replyToken, '📸 กรุณาแนบเอกสารประกอบ');
  }

  if (user.flow === 'safe_request_attachment') {
    return replyText(event.replyToken, 'กรุณาแนบรูปภาพเอกสารประกอบ หรือพิมพ์ ยกเลิก');
  }

  return replyText(event.replyToken, 'ไม่พบขั้นตอนที่กำลังทำรายการ');
}

async function handleBankRequestText(event, user, text) {
  if (text === 'ยกเลิก' || text.toLowerCase() === 'cancel') {
    clearFlow(user);
    return replyText(event.replyToken, 'ยกเลิกรายการเรียบร้อยแล้ว');
  }

  const req = user.requestDraft;
  if (!req) {
    clearFlow(user);
    return replyText(event.replyToken, 'ไม่พบรายการที่กำลังทำอยู่');
  }

  if (user.flow === 'bank_request_reference') {
    req.referenceNumber = text;
    user.flow = 'bank_request_bank_name';
    saveDb();
    return replyText(event.replyToken, 'กรุณาระบุชื่อธนาคาร เช่น กสิกร / ไทยพาณิชย์ / กรุงเทพ');
  }

  if (user.flow === 'bank_request_bank_name') {
    req.bankName = text;
    user.flow = 'bank_request_date_range';
    saveDb();
    return replyText(event.replyToken, 'กรุณาระบุช่วงวันที่เริ่มต้น - วันที่สิ้นสุด ที่ต้องการข้อมูล');
  }

  if (user.flow === 'bank_request_date_range') {
    req.dateRange = text;
    user.flow = 'bank_request_case_name';
    saveDb();
    return replyText(event.replyToken, 'กรุณาระบุชื่อเคส');
  }

  if (user.flow === 'bank_request_case_name') {
    req.caseName = text;
    user.flow = 'bank_request_note';
    saveDb();
    return replyText(event.replyToken, 'กรุณาระบุรายละเอียดประกอบอื่น ๆ');
  }

  if (user.flow === 'bank_request_note') {
    req.note = text;
    user.flow = 'bank_request_attachment';
    saveDb();
    return replyText(event.replyToken, '📸 กรุณาแนบเอกสารประกอบอื่น ๆ');
  }

  if (user.flow === 'bank_request_attachment') {
    return replyText(event.replyToken, 'กรุณาแนบรูปภาพเอกสารประกอบ หรือพิมพ์ ยกเลิก');
  }

  return replyText(event.replyToken, 'ไม่พบขั้นตอนที่กำลังทำรายการ');
}

async function handleTextMessage(event) {
  const userId = event.source.userId;
  const user = ensureUser(userId);
  const text = (event.message.text || '').trim();

  if (!user.lineName) {
    const profile = await getProfileSafe(userId);
    if (profile?.displayName) {
      user.lineName = profile.displayName;
      saveDb();
    }
  }

  if (text.toLowerCase() === 'help') {
    return replyMessages(event.replyToken, [buildHelpFlex()]);
  }

  if (text.toLowerCase() === 'support') {
    return replyMessages(event.replyToken, [buildSupportFlex()]);
  }

  if (text.startsWith('sendto#')) {
    return handleAdminSendMessage(event, text);
  }

  if (text === 'myid') {
    return replyText(event.replyToken, `UID: ${userId}`);
  }

  if (text.startsWith('re#')) {
    return handleRegisterCommand(event, text);
  }

  if (text === 'เช็คสถานะ') {
    return handleStatusCheck(event);
  }

  if (text === 'base@') {
    return handleBaseStart(event, user);
  }

  if (text === 'bank@') {
    return handleBankStart(event, user);
  }

  if (user.flow && user.flow.startsWith('safe_request_')) {
    return handleSafeRequestText(event, user, text);
  }

  if (user.flow && user.flow.startsWith('bank_request_')) {
    return handleBankRequestText(event, user, text);
  }

  if (text === 'ยกเลิก' || text.toLowerCase() === 'cancel') {
    if (user.flow) {
      clearFlow(user);
      return replyText(event.replyToken, 'ยกเลิกรายการเรียบร้อยแล้ว');
    }
    return replyText(event.replyToken, 'ไม่มีรายการที่กำลังทำอยู่');
  }

  return replyMessages(event.replyToken, [buildHelpFlex()]);
}

async function handleImageMessage(event) {
  const userId = event.source.userId;
  const user = ensureUser(userId);

  if (user.status === 'waiting_card') {
    return handleRegistrationCardUpload(event, user);
  }

  if (user.flow === 'safe_request_attachment') {
    return handleSafeRequestImageUpload(event, user);
  }

  if (user.flow === 'bank_request_attachment') {
    return handleBankRequestImageUpload(event, user);
  }

  return replyText(event.replyToken, 'ระบบยังไม่ได้อยู่ในขั้นตอนรับรูปภาพ');
}

async function handleEvent(event) {
  const eventId = event.webhookEventId;
  if (eventId && isEventProcessed(eventId)) {
    return null;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const result = await handleTextMessage(event);
    if (eventId) markEventProcessed(eventId);
    return result;
  }

  if (event.type === 'message' && event.message.type === 'image') {
    const result = await handleImageMessage(event);
    if (eventId) markEventProcessed(eventId);
    return result;
  }

  if (event.type === 'postback') {
    const result = await handlePostback(event);
    if (eventId) markEventProcessed(eventId);
    return result;
  }

  if (eventId) markEventProcessed(eventId);
  return null;
}

app.use('/files', express.static(UPLOAD_DIR));

app.get('/', (_, res) => {
  res.send('LINE registration bot is running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

/*
.env example
LINE_CHANNEL_ACCESS_TOKEN=xxxxxxxx
LINE_CHANNEL_SECRET=xxxxxxxx
LINE_ADMIN_USER_IDS=Uxxxxxxxx,Uyyyyyyyy
BASE_URL=https://your-render-domain.onrender.com
PERSIST_DIR=/var/data
PORT=3000

package.json dependencies
{
  "dependencies": {
    "@line/bot-sdk": "^10.4.0",
    "axios": "^1.7.7",
    "dotenv": "^16.4.5",
    "express": "^4.21.1"
  }
}
*/

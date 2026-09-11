import { fetchApi } from '../../utils/api';

const asList = (d) => {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.messages)) return d.messages;
  if (Array.isArray(d?.data)) return d.data;
  return [];
};

export const patchContact = (id, data) =>
  fetchApi(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const assignOwner = (id, assignedToId) =>
  fetchApi(`/api/contacts/${id}/assign`, { method: 'PUT', body: JSON.stringify({ assignedToId }) });

export const postActivity = (id, { type, description }) =>
  fetchApi(`/api/contacts/${id}/activities`, { method: 'POST', body: JSON.stringify({ type, description }) });

export const createTask = (data) =>
  fetchApi('/api/tasks', { method: 'POST', body: JSON.stringify(data) });

export async function fetchActivities(contactId, page = 1, limit = 10) {
  const d = await fetchApi('/api/contacts/' + contactId + '/activities?page=' + page + '&limit=' + limit, { silent: true });
  return {
    data: Array.isArray(d?.data) ? d.data : [],
    total: Number(d?.total) || 0,
    page: Number(d?.page) || page,
    limit: Number(d?.limit) || limit,
    totalPages: Number(d?.totalPages) || 1,
  };
}

export const sendEmail = (data) =>
  fetchApi('/api/communications/send-email', { method: 'POST', body: JSON.stringify(data) });

export const sendSms = (data) =>
  fetchApi('/api/sms/send', { method: 'POST', body: JSON.stringify(data) });

export const sendWhatsapp = (data) =>
  fetchApi('/api/whatsapp/send', { method: 'POST', body: JSON.stringify(data) });

export const createDeal = (data) =>
  fetchApi('/api/deals', { method: 'POST', body: JSON.stringify(data) });

export const updateDeal = (dealId, data) =>
  fetchApi(`/api/deals/${dealId}`, { method: 'PUT', body: JSON.stringify(data) });

export const fetchScore = (contactId) =>
  fetchApi(`/api/ai_scoring/contact/${contactId}`, { silent: true });

export async function fetchStaff() {
  try {
    const d = await fetchApi('/api/staff?fields=summary', { silent: true });
    if (Array.isArray(d)) return d;
    return d?.staff || d?.users || d?.data || [];
  } catch {
    return [];
  }
}

export async function fetchSmsMessages(contactId) {
  try {
    const d = await fetchApi(`/api/sms/messages?contactId=${contactId}`, { silent: true });
    return asList(d);
  } catch {
    return [];
  }
}

export async function fetchWhatsappMessages(contactId) {
  try {
    const d = await fetchApi(`/api/whatsapp/messages?contactId=${contactId}`, { silent: true });
    return asList(d);
  } catch {
    return [];
  }
}

export async function fetchWhatsappThreads(contactId) {
  try {
    const d = await fetchApi('/api/whatsapp/threads', { silent: true });
    return asList(d).filter((t) => String(t.contactId) === String(contactId));
  } catch {
    return [];
  }
}

export async function fetchEmailThreads() {
  try {
    const d = await fetchApi('/api/email/threads', { silent: true });
    return asList(d);
  } catch {
    return [];
  }
}

export async function fetchSiblings(limit = 200) {
  try {
    const d = await fetchApi(`/api/contacts?limit=${limit}`, { silent: true });
    return asList(d);
  } catch {
    return [];
  }
}

export async function fetchAttachments(contactId) {
  try {
    const d = await fetchApi(`/api/contacts/${contactId}/attachments`, { silent: true });
    return asList(d);
  } catch {
    return [];
  }
}

export const deleteAttachment = (attachId) =>
  fetchApi(`/api/contacts/attachments/${attachId}`, { method: 'DELETE' });

async function uploadBatch(endpoint, fieldName, files) {
  if (!files.length) return [];
  const form = new FormData();
  files.forEach((f) => form.append(fieldName, f, f.name));
  const result = await fetchApi(endpoint, { method: 'POST', body: form });
  return Array.isArray(result?.urls) ? result.urls : [];
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

export async function uploadContactFiles(contactId, files) {
  const images = files.filter((f) => String(f.type || '').startsWith('image/') || IMAGE_RE.test(f.name || ''));
  const docs = files.filter((f) => !images.includes(f));
  const [upImages, upDocs] = await Promise.all([
    uploadBatch('/api/uploads/images', 'images', images),
    uploadBatch('/api/uploads/documents', 'documents', docs),
  ]);
  const uploaded = [...upImages, ...upDocs];
  await Promise.all(
    uploaded.map((item) => {
      const match = files.find((f) => f.name === item.fileName && f.size === item.size);
      return fetchApi(`/api/contacts/${contactId}/attachments`, {
        method: 'POST',
        body: JSON.stringify({
          filename: item.fileName,
          fileUrl: item.url,
          fileSize: item.size,
          mimeType: match?.type || null,
        }),
      });
    }),
  );
  return uploaded.length;
}

export async function syncMeetingToCalendar(payload) {
  for (const provider of ['google', 'outlook']) {
    try {
      await fetchApi(`/api/calendar/${provider}/events`, { method: 'POST', body: JSON.stringify(payload) });
      return true;
    } catch (err) {
      const status = err?.status || err?.body?.status;
      const message = String(err?.message || err?.body?.error || '').toLowerCase();
      if (status === 404 || message.includes('not connected')) continue;
      break;
    }
  }
  return false;
}

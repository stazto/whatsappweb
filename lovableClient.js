/**
 * lovableClient.js
 *
 * Processa mensagens recebidas, chama a IA do Lovable e responde automaticamente.
 */

import fetch from 'cross-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

/** ───────────────────────── Helpers ───────────────────────── **/
function normPhoneToBR55(raw) {
  // mantém apenas dígitos
  const digits = String(raw || '').replace(/\D+/g, '');
  if (!digits) return '';
  // já vem com 55?
  if (digits.startsWith('55')) return digits;
  // remove 0 inicial (DDD/telefone)
  const noLeading0 = digits.replace(/^0+/, '');
  return `55${noLeading0}`;
}

async function sb(path, { method = 'GET', headers = {}, body } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL/SUPABASE_KEY não configurados');
  }
  const url = `${SUPABASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 204/201 podem vir sem body
  const isJson =
    (res.headers.get('content-type') || '').includes('application/json');

  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const text = !isJson ? await res.text().catch(() => '') : JSON.stringify(data);
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return { res, data };
}

/** ─────────────────── Persistência no Supabase ─────────────────── **/
async function upsertConversationGetId(clinicId, phone55) {
  // 1) tenta achar conversa
  const { data: convs } = await sb(
    `/rest/v1/whatsapp_conversations?clinic_id=eq.${clinicId}&patient_phone=eq.${phone55}&select=id`
  );

  let conversationId = Array.isArray(convs) && convs[0]?.id ? convs[0].id : null;

  if (conversationId) {
    // atualiza last_message_at
    await sb(`/rest/v1/whatsapp_conversations?id=eq.${conversationId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { last_message_at: new Date().toISOString() },
    });
    return conversationId;
  }

  // 2) cria conversa
  const { data: created } = await sb('/rest/v1/whatsapp_conversations', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: {
      clinic_id: clinicId,
      patient_phone: phone55,
      status: 'active',
    },
  });

  conversationId = Array.isArray(created) && created[0]?.id ? created[0].id : null;
  return conversationId;
}

async function saveMessage(clinicId, phoneRaw, content, messageType, whatsappMessageId) {
  try {
    const phone55 = normPhoneToBR55(phoneRaw);
    if (!phone55) throw new Error('Telefone inválido');

    const conversationId = await upsertConversationGetId(clinicId, phone55);
    if (!conversationId) {
      console.error('❌ Erro ao obter conversation_id');
      return false;
    }

    await sb('/rest/v1/whatsapp_messages', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: {
        clinic_id: clinicId,
        conversation_id: conversationId,
        message_type: messageType, // 'received' | 'sent'
        content,
        status: 'delivered',
        whatsapp_message_id: whatsappMessageId || null,
      },
    });

    return true;
  } catch (err) {
    console.error('❌ Erro salvando mensagem:', err?.message || err);
    return false;
  }
}

/** ─────────────────────── IA (Edge Function) ─────────────────────── **/
async function getAIResponse(clinicId, patientPhoneRaw, message) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error('❌ SUPABASE_URL ou SUPABASE_KEY não configurados');
      return 'Desculpe, configuração incorreta. Entre em contato com o suporte.';
    }

    // use o phone normalizado para a IA também
    const patient_phone = normPhoneToBR55(patientPhoneRaw);

    const endpoint = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/chat-assistant-whatsapp`;
    console.log(`🤖 Chamando IA: ${endpoint}`);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        clinic_id: clinicId,
        patient_phone,
        message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('❌ Erro na API Lovable:', response.status, errorText);

      if (response.status === 429) {
        return 'Desculpe, estamos com muitas requisições no momento. Tente novamente em alguns minutos.';
      }
      if (response.status === 402) {
        return 'Desculpe, sistema temporariamente indisponível. Entre em contato com a clínica.';
      }
      return 'Desculpe, tive um problema ao processar sua mensagem. Tente novamente.';
    }

    const data = await response.json().catch(() => ({}));
    console.log('✅ Resposta da IA recebida');
    return data.reply || 'Desculpe, não consegui gerar uma resposta.';
  } catch (error) {
    console.error('❌ Erro ao chamar API Lovable:', error?.message || error);
    return 'Desculpe, estou com dificuldades técnicas. Tente novamente mais tarde.';
  }
}

/** ───────────────────── Handler público ───────────────────── **/
/**
 * Processa mensagem recebida do WhatsApp e responde com a IA do Lovable.
 * Retorna true/false indicando se a resposta foi enviada.
 */
export async function processIncomingMessage(client, message, clinicId) {
  try {
    // Ignorar mensagens próprias, grupos e não-chat
    const from = String(message?.from || '');
    const type = String(message?.type || 'chat');
    const isGroup = from.endsWith('@g.us');

    if (message?.fromMe || isGroup || type !== 'chat') return false;

    const fromNumber = from.replace('@c.us', '');
    const text = String(message?.body || '').trim();
    const messageId = message?.id?.id || message?.id?._serialized || null;

    if (!fromNumber || !text) return false;

    console.log(`📩 Nova mensagem de ${fromNumber}: ${text}`);

    // 1) Log recebido
    await saveMessage(clinicId, fromNumber, text, 'received', messageId);

    // 2) IA
    const aiReply = await getAIResponse(clinicId, fromNumber, text);
    if (!aiReply) {
      console.error('❌ Nenhuma resposta da IA');
      return false;
    }
    console.log(`🤖 IA respondeu: ${aiReply}`);

    // 3) Envia no WhatsApp
    await client.sendMessage(from, aiReply);

    // 4) Log enviado
    await saveMessage(clinicId, fromNumber, aiReply, 'sent', null);

    console.log('✅ Mensagem enviada e salva');
    return true;
  } catch (error) {
    console.error('❌ Erro processando mensagem:', error?.message || error);
    return false;
  }
}

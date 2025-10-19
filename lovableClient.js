/**
 * lovableClient.js
 * 
 * Este arquivo deve estar na VM junto com o server.js do whatsapp-web.js
 * Ele processa mensagens recebidas, chama a IA do Lovable e responde automaticamente
 */

import fetch from 'cross-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

/**
 * Processa mensagem recebida do WhatsApp
 * @param {object} client - Cliente whatsapp-web.js
 * @param {object} message - Mensagem recebida
 * @param {string} clinicId - ID da clínica
 */
export async function processIncomingMessage(client, message, clinicId) {
  try {
    // Ignorar mensagens próprias e de grupos
    // (em whatsapp-web.js, grupos terminam com @g.us)
    if (message.fromMe || String(message.from || '').endsWith('@g.us')) {
      return;
    }

    const from = String(message.from || '').replace('@c.us', '');
    const text = message.body;
    const messageId = message?.id?.id;

    if (!from || !text) return;

    console.log(`📩 Nova mensagem de ${from}: ${text}`);

    // 1. Salvar mensagem recebida no Supabase
    await saveMessage(clinicId, from, text, 'received', messageId);

    // 2. Chamar IA para gerar resposta (nova edge function multi-tenant)
    const aiReply = await getAIResponse(clinicId, from, text);

    if (!aiReply) {
      console.error('❌ Nenhuma resposta da IA');
      return;
    }

    console.log(`🤖 IA respondeu: ${aiReply}`);

    // 3. Enviar resposta pelo WhatsApp (API correta do whatsapp-web.js)
    await client.sendMessage(message.from, aiReply);

    // 4. Salvar resposta da IA no Supabase
    await saveMessage(clinicId, from, aiReply, 'sent', null);

    console.log(`✅ Mensagem enviada e salva`);

  } catch (error) {
    console.error('❌ Erro processando mensagem:', error);
  }
}

/**
 * Salva mensagem no Supabase
 */
async function saveMessage(clinicId, phone, content, messageType, whatsappMessageId) {
  try {
    // Formatar telefone no padrão internacional (55XXXXXXXXXXX)
    const formattedPhone = phone.startsWith('55') ? phone : `55${phone}`;

    // 1. Buscar ou criar conversa
    const conversationResponse = await fetch(
      `https://lqouhkwszyseethnhvoo.supabase.co/rest/v1/whatsapp_conversations?clinic_id=eq.${clinicId}&patient_phone=eq.${formattedPhone}&select=id`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let conversationId;
    const conversations = await conversationResponse.json();

    if (conversations && conversations.length > 0) {
      conversationId = conversations[0].id;

      // Atualizar last_message_at
      await fetch(
        `https://lqouhkwszyseethnhvoo.supabase.co/rest/v1/whatsapp_conversations?id=eq.${conversationId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            last_message_at: new Date().toISOString()
          })
        }
      );
    } else {
      // Criar nova conversa
      const newConvResponse = await fetch(
        'https://lqouhkwszyseethnhvoo.supabase.co/rest/v1/whatsapp_conversations',
        {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            clinic_id: clinicId,
            patient_phone: formattedPhone,
            status: 'active'
          })
        }
      );

      const newConv = await newConvResponse.json();
      conversationId = newConv[0]?.id;
    }

    if (!conversationId) {
      console.error('❌ Erro ao obter conversation_id');
      return;
    }

    // 2. Salvar mensagem
    await fetch(
      'https://lqouhkwszyseethnhvoo.supabase.co/rest/v1/whatsapp_messages',
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          clinic_id: clinicId,
          conversation_id: conversationId,
          message_type: messageType,
          content: content,
          status: 'delivered',
          whatsapp_message_id: whatsappMessageId
        })
      }
    );

  } catch (error) {
    console.error('❌ Erro salvando mensagem:', error);
  }
}

/**
 * Chama a IA da Lovable usando a nova edge function chat-assistant-whatsapp
 * Esta função é multi-tenant e identifica automaticamente clinic e patient
 */
async function getAIResponse(clinicId, patientPhone, message) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error('❌ SUPABASE_URL ou SUPABASE_KEY não configurados');
      return 'Desculpe, configuração incorreta. Entre em contato com o suporte.';
    }

    const endpoint = `${SUPABASE_URL}/functions/v1/chat-assistant-whatsapp`;
    
    console.log(`🤖 Chamando IA: ${endpoint}`);
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        clinic_id: clinicId,
        patient_phone: patientPhone,
        message: message
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Erro na API Lovable:', response.status, errorText);
      
      if (response.status === 429) {
        return 'Desculpe, estamos com muitas requisições no momento. Tente novamente em alguns minutos.';
      }
      if (response.status === 402) {
        return 'Desculpe, sistema temporariamente indisponível. Entre em contato com a clínica.';
      }
      
      return 'Desculpe, tive um problema ao processar sua mensagem. Tente novamente.';
    }

    const data = await response.json();
    console.log(`✅ Resposta da IA recebida`);
    
    return data.reply || 'Desculpe, não consegui gerar uma resposta.';
  } catch (error) {
    console.error('❌ Erro ao chamar API Lovable:', error);
    return 'Desculpe, estou com dificuldades técnicas. Tente novamente mais tarde.';
  }
}

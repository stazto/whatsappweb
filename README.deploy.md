# Cloud Run + Firestore + WhatsApp Cloud API (Node 20)

Webhook 24/7, multi-tenant, com IA no Lovable e logs no Firestore.

## 1) Pré-requisitos
- gcloud CLI autenticado no seu projeto
- Firestore em modo nativo
- App do WhatsApp Cloud API no Meta

## 2) Habilitar serviços
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

## 3) Firestore (nativo)
gcloud firestore databases create --region=europe-west2

## 4) Deploy no Cloud Run (fonte local, Node 20)
gcloud run deploy whatsapp-webhook   --source .   --region=europe-west2   --allow-unauthenticated   --cpu=1 --memory=512Mi --max-instances=10   --set-env-vars WHATSAPP_VERIFY_TOKEN=change-me,META_GRAPH_VERSION=v20.0   --set-env-vars LOVABLE_AI_ENDPOINT=https://your-lovable-app.run.app/api/ai/reply,LOVABLE_API_KEY=change-me   --ingress all   --service-account your-sa@your-project.iam.gserviceaccount.com

## 5) Configurar Webhook no Meta
- Callback URL: https://<CLOUD_RUN_URL>/webhook
- Verify Token: igual a WHATSAPP_VERIFY_TOKEN
- Assine o campo messages e adicione seu phone number

## 6) Registrar tenants (multiusuário)
Crie documentos em tenants/{tenantId}:
{
  "displayName": "Clínica Odonto XYZ",
  "status": "active",
  "waba": {
    "businessId": "1234567890",
    "phoneNumberId": "123456789012345",
    "accessToken": "EAAG...long-lived-token..."
  },
  "ai": {
    "endpointUrl": "https://your-lovable-app.run.app/api/ai/reply",
    "apiKey": "tenant-specific-key-optional"
  }
}

Produção: armazene o token no Secret Manager e salve apenas accessTokenSecretName no Firestore.

## 7) Teste rápido
curl -X POST https://<CLOUD_RUN_URL>/webhook   -H 'Content-Type: application/json'   -d '{
    "object":"whatsapp_business_account",
    "entry":[{
      "changes":[{
        "value":{
          "metadata":{"phone_number_id":"123456789012345"},
          "messages":[{"from":"5581988887777","id":"wamid.HBg...","timestamp":"1730000000","text":{"body":"Oi!"},"type":"text"}]
        },
        "field":"messages"
      }]
    }]
  }'

## 8) Segurança & Produção
- Secret Manager para tokens por tenant
- (Opcional) validar X-Hub-Signature-256 (requer APP_SECRET e raw body)
- Idempotência por messages[*].id
- Observabilidade no Cloud Logging/Error Reporting
- Cloud Tasks para picos

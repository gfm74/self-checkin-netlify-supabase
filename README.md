# Self Check-In

Questa versione sostituisce FormSubmit con:

- frontend statico su Netlify
- Netlify Function per ricevere il selfie
- Supabase Storage per archiviare le foto
- Supabase Table per tracciare gli invii ed evitare duplicati

## Come funziona

1. L'ospite scatta o seleziona il selfie.
2. Il browser comprime l'immagine in JPEG.
3. La pagina invia il file a `/.netlify/functions/upload-selfie`.
4. La function salva i metadati in Supabase e carica il file nel bucket Storage.
5. In caso di successo l'utente viene reindirizzato a `success.html`.

## Dove vedere le foto

- `Supabase Dashboard` -> `Storage` -> bucket `selfies`
- `Supabase Dashboard` -> `Table Editor` -> tabella `checkin_selfies`

Consiglio: bucket privato e accesso solo da dashboard, così le foto non sono pubbliche.

## Setup Supabase

### 1. Crea un bucket

Nome suggerito: `selfies`

- apri `Storage`
- crea il bucket
- imposta il bucket come `private`

### 2. Crea la tabella

Esegui questo SQL in `SQL Editor`:

```sql
create extension if not exists pgcrypto;

create table if not exists public.checkin_selfies (
  id uuid primary key default gen_random_uuid(),
  submission_id text not null unique,
  language text,
  file_path text not null,
  file_name text,
  mime_type text,
  size_bytes integer,
  client_timestamp timestamptz,
  source text,
  status text not null default 'stored',
  created_at timestamptz not null default now()
);
```

### 3. Variabili ambiente su Netlify

Imposta queste variabili nel sito Netlify:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `SUPABASE_CHECKINS_TABLE`

Puoi usare `.env.example` come promemoria.

## Note importanti

- La function usa la `service role key`, quindi la chiave deve restare solo su Netlify e mai nel frontend.
- Questa base evita i doppi invii tramite `submission_id` univoco.
- Le foto vengono compresse lato browser per ridurre errori da mobile e occupazione spazio.

## Notifica email opzionale

La function supporta una notifica email con link temporaneo alla foto usando Resend.

Al 5 aprile 2026, il piano gratuito di Resend include `3.000 email/mese` e `100 email/giorno`.

Fonti:

- [Resend pricing](https://resend.com/pricing)
- [Resend send email API](https://resend.com/docs/api-reference/emails/send-email)
- [Supabase signed URLs](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl)

Per attivarla, aggiungi su Netlify queste variabili:

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `SELFIE_NOTIFY_TO`
- `SELFIE_LINK_EXPIRES_IN`

Esempio valori:

- `RESEND_API_KEY` = chiave API Resend
- `RESEND_FROM_EMAIL` = `Self Check-In <onboarding@resend.dev>` per i primi test
- `SELFIE_NOTIFY_TO` = la tua email
- `SELFIE_LINK_EXPIRES_IN` = `604800` per un link valido 7 giorni

Se queste variabili non sono presenti, l'app continua a funzionare senza inviare email.

## Notifica Telegram opzionale

Se vuoi una notifica piu' veloce da configurare, puoi usare Telegram invece dell'email.

La function supporta anche:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `SELFIE_LINK_EXPIRES_IN`

Flusso consigliato:

1. crea un bot con BotFather
2. recupera il token del bot
3. invia un messaggio al bot dal tuo account Telegram
4. recupera il tuo `chat_id`
5. aggiungi le variabili su Netlify

Quando arriva un nuovo selfie, ricevi un messaggio Telegram con link temporaneo alla foto.

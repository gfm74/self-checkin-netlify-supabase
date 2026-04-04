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
- Se vuoi, come passo successivo possiamo aggiungere una mail di notifica con link alla foto invece dell'allegato.

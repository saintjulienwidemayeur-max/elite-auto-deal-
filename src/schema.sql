-- Elite Auto Deal : schéma PostgreSQL (idempotent)
create table if not exists parametres (
  cle text primary key,
  valeur jsonb not null
);

create table if not exists vehicules (
  id text primary key,
  marque text not null,
  modele text not null,
  annee int,
  couleur text,
  hex text default '#6F7379',
  km int,
  prix numeric(12,2),
  statut text not null default 'disponible' check (statut in ('disponible','transit','precommande','vendu','indisponible')),
  type text default 'SUV',
  forme text default 'suv' check (forme in ('suv','berline','pickup')),
  moteur text, trans text, traction text, places int,
  delai text, note text,
  vedette boolean not null default false,
  retire boolean not null default false,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now()
);

create table if not exists dossiers (
  ref text primary key,
  service text not null check (service in ('precommande','achat','consultation','recherche','essai','vendre','financement')),
  vehicule_id text references vehicules(id),
  client_nom text not null,
  client_tel text not null,
  client_whatsapp text,
  client_email text,
  donnees jsonb not null default '{}'::jsonb,
  montant_usd numeric(12,2) not null,
  prix_vehicule_usd numeric(12,2),
  etape int not null default 0,
  etat text not null default 'paiement_en_attente' check (etat in ('paiement_en_attente','a_traiter','en_cours','validation_requise','cloture')),
  arrive boolean not null default false,
  statut_solde text not null default 'non_du' check (statut_solde in ('non_du','a_envoyer','envoye','paye')),
  conditions_acceptees_le timestamptz not null,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now()
);
create index if not exists dossiers_service_idx on dossiers(service);
create index if not exists dossiers_etat_idx on dossiers(etat);

create table if not exists paiements (
  id bigserial primary key,
  ref text not null references dossiers(ref) on delete cascade,
  type text not null default 'initial' check (type in ('initial','solde')),
  tentative int not null default 1,
  freda_reference text not null unique,       -- référence envoyée à Freda Pay Issuing (idempotence)
  freda_id text unique,
  methode text not null check (methode in ('mobile','carte')),
  montant numeric(14,2) not null,
  devise text not null check (devise in ('HTG','USD')),
  montant_usd numeric(12,2) not null,
  taux_htg numeric(10,4),
  statut text not null default 'pending' check (statut in ('pending','succeeded','failed')),
  checkout_url text,
  frais numeric(14,2),
  net numeric(14,2),
  echec_raison text,
  derniere_verif timestamptz,
  cree_le timestamptz not null default now(),
  confirme_le timestamptz
);
create index if not exists paiements_ref_idx on paiements(ref);

create table if not exists fichiers (
  id bigserial primary key,
  ref text not null references dossiers(ref) on delete cascade,
  champ text,
  nom text not null,
  type text,
  taille bigint,
  stockage text not null,      -- 'local' ou 'supabase'
  chemin text not null,
  cree_le timestamptz not null default now()
);

create table if not exists journal (
  id bigserial primary key,
  ref text,
  quand timestamptz not null default now(),
  type text not null default 'info',
  texte text not null,
  par text not null default 'système'
);
create index if not exists journal_quand_idx on journal(quand desc);

create table if not exists webhook_evenements (
  id text primary key,          -- id de l'événement Freda (idempotence)
  evenement text not null,
  recu_le timestamptz not null default now(),
  corps jsonb not null
);

create table if not exists photos_vehicules (
  id bigserial primary key,
  vehicule_id text not null references vehicules(id) on delete cascade,
  stockage text not null,
  chemin text not null,
  type text,
  taille bigint,
  ordre int not null default 0,
  cree_le timestamptz not null default now()
);
create index if not exists photos_vehicules_v_idx on photos_vehicules(vehicule_id, ordre, id);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  tel text not null,
  tel_norm text not null unique,
  whatsapp text,
  email text,
  mdp_hash text not null,
  reinit_hash text,
  reinit_expire timestamptz,
  reinit_demandee boolean not null default false,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now()
);
create unique index if not exists clients_email_idx on clients(lower(email)) where email is not null;
alter table dossiers add column if not exists client_id uuid references clients(id) on delete set null;
create index if not exists dossiers_client_idx on dossiers(client_id);

-- Codes à usage unique (OTP) envoyés par email : vérification d'adresse et réinitialisation du mot de passe
alter table clients add column if not exists email_verifie_le timestamptz;
create table if not exists otp_codes (
  id bigserial primary key,
  client_id uuid not null references clients(id) on delete cascade,
  finalite text not null check (finalite in ('verification','reinit')),
  code_hash text not null,
  expire_le timestamptz not null,
  tentatives int not null default 0,
  utilise boolean not null default false,
  cree_le timestamptz not null default now()
);
create index if not exists otp_codes_client_idx on otp_codes(client_id, finalite, cree_le desc);

-- Moyens de paiement : MonCash et Natcash séparés ('mobile' = anciens paiements, avant la séparation)
alter table paiements drop constraint if exists paiements_methode_check;
alter table paiements add constraint paiements_methode_check check (methode in ('mobile','moncash','natcash','carte'));

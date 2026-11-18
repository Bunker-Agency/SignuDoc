-- Three more kinds of field that fill in from the signer: their name, job
-- title and company.
--
-- Nobody types into a name box; it shows the signer's name. The job title and
-- company the signer gives are kept on the signer, so the certificate can
-- show them.

alter table public.fields
  drop constraint if exists fields_type_check;

alter table public.fields
  add constraint fields_type_check check (
    type in (
      'signature',
      'initials',
      'date',
      'text',
      'checkbox',
      'number',
      'dropdown',
      'radio',
      'name',
      'job_title',
      'company'
    )
  );

alter table public.signers
  add column if not exists job_title text,
  add column if not exists company text;

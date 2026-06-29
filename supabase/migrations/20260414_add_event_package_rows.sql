-- Add the two new website package rows to Supabase.
-- Note: public.package does not currently have a separate `package_details` column,
-- so the longer package summary is stored in `description`.

insert into public.package (
  package_name,
  description,
  package_type,
  price,
  guest_capacity,
  extension_price,
  location_type,
  is_active,
  duration_hours
)
select
  'Intimate Wedding Package',
  'Venue and catering package for intimate weddings and simple celebrations. Includes Main Hall and VIP Hall access, 3 hours use of the reception hall, 1 hour ingress, buffet setup, 3 main courses, pasta or noodles, dessert, drinks, and lights and sounds.',
  'main',
  0,
  null,
  null,
  'onsite',
  true,
  3
where not exists (
  select 1
  from public.package
  where package_name = 'Intimate Wedding Package'
);

insert into public.package (
  package_name,
  description,
  package_type,
  price,
  guest_capacity,
  extension_price,
  location_type,
  is_active,
  duration_hours
)
select
  'Birthday / Baptism All In Package',
  'All-in celebration package with venue, catering, and event add-ons for intimate parties. Includes Main Hall and VIP Hall access, 3 hours use of the reception hall, 1 hour ingress, buffet setup, 3 main courses, pasta or noodles, dessert, drinks, and lights and sounds.',
  'main',
  0,
  null,
  null,
  'onsite',
  true,
  3
where not exists (
  select 1
  from public.package
  where package_name = 'Birthday / Baptism All In Package'
);

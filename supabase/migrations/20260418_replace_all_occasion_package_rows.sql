update public.package
set is_active = false
where package_name in (
  'Intimate Wedding Package',
  'Birthday / Baptism All In Package'
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
  'All-Occasion Party Package - Essential 50 Pax',
  'Suitable for birthdays, anniversaries, baptism, graduation, reunions, and corporate events. Essential catering package with 1 pork dish, 1 chicken dish, 1 fish or vegetable dish, 1 pasta or noodles, 1 dessert, rice, drinks, full buffet setup, dressed tables and chairs, basic backdrop, and balloon or flower accents.',
  'main',
  28000,
  50,
  450,
  'offsite',
  true,
  4
where not exists (
  select 1
  from public.package
  where package_name = 'All-Occasion Party Package - Essential 50 Pax'
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
  'All-Occasion Party Package - Essential 100 Pax',
  'Suitable for birthdays, anniversaries, baptism, graduation, reunions, and corporate events. Essential catering package with 1 pork dish, 1 chicken dish, 1 fish or vegetable dish, 1 pasta or noodles, 1 dessert, rice, drinks, full buffet setup, dressed tables and chairs, basic backdrop, and balloon or flower accents.',
  'main',
  48000,
  100,
  450,
  'offsite',
  true,
  4
where not exists (
  select 1
  from public.package
  where package_name = 'All-Occasion Party Package - Essential 100 Pax'
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
  'All-Occasion Party Package - Standard 50 Pax',
  'Best seller all-occasion catering package with 1 pork or beef dish, 1 chicken dish, 1 fish or vegetable dish, 1 pasta or noodles, 1 dessert, rice, drinks, full buffet setup, event styling, host or singer, lights and sounds, photobooth or photo coverage, grazing table, coffee station, and 1 reception coordinator.',
  'main',
  58000,
  50,
  550,
  'offsite',
  true,
  4
where not exists (
  select 1
  from public.package
  where package_name = 'All-Occasion Party Package - Standard 50 Pax'
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
  'All-Occasion Party Package - Standard 100 Pax',
  'Best seller all-occasion catering package with 1 pork or beef dish, 1 chicken dish, 1 fish or vegetable dish, 1 pasta or noodles, 1 dessert, rice, drinks, full buffet setup, event styling, host or singer, lights and sounds, photobooth or photo coverage, grazing table, coffee station, and 1 reception coordinator.',
  'main',
  82000,
  100,
  550,
  'offsite',
  true,
  4
where not exists (
  select 1
  from public.package
  where package_name = 'All-Occasion Party Package - Standard 100 Pax'
);

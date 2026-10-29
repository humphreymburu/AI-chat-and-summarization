-- Daily question counts used to limit chat use.
-- subject is "user:<id>" for signed-in users or "ip:<address>" for guests.
create table if not exists chat_usage (
  subject text not null,
  day     date not null default current_date,
  count   integer not null default 0,
  primary key (subject, day)
);

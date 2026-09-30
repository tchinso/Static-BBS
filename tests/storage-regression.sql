-- Run inside a transaction; this file always rolls back its own fixtures.
select set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare owner_value uuid; category_value uuid; large_path text; small_path text;
  post_value uuid; second_post uuid; files jsonb := '[]'; index_value integer;
  rejected boolean; canonical_size bigint;
begin
  select id into owner_value from auth.users limit 1;
  select id into category_value from public.community_categories limit 1;
  if owner_value is null or category_value is null then raise exception 'Test requires one existing user/category.'; end if;
  large_path := owner_value::text||'/'||gen_random_uuid()::text||'-test.bin';
  small_path := owner_value::text||'/'||gen_random_uuid()::text||'-test.txt';
  perform public.community_reserve_upload('community-files',large_path,'25MB.bin',26214400,owner_value);
  perform public.community_reserve_upload('community-files',small_path,'one-byte.txt',1,owner_value);
  insert into storage.objects(bucket_id,name,metadata) values
    ('community-files',large_path,'{"size":26214400,"mimetype":"application/octet-stream"}'),
    ('community-files',small_path,'{"size":1,"mimetype":"text/plain"}');
  -- The DB canonicalizes forged size/name values from trusted reservations.
  insert into public.community_posts(category_id,title,content,author_id,author_name,attachments)
  values(category_value,'__transaction_test__','test',owner_value,'test',jsonb_build_array(jsonb_build_object('path',large_path,'name','forged','size',1)))
  returning id,(attachments->0->>'size')::bigint into post_value,canonical_size;
  if canonical_size<>26214400 then raise exception 'Attachment size was not canonicalized'; end if;
  if exists(select 1 from public.community_image_cleanup_queue where bucket_id='community-files' and object_path=large_path) then raise exception 'Attached upload remained queued'; end if;
  rejected := false;
  begin
    update public.community_posts set attachments = attachments||jsonb_build_array(jsonb_build_object('path',small_path,'name','small','size',1)) where id=post_value;
  exception when check_violation then rejected := true;
  end;
  if not rejected then raise exception '25MB+1 byte was accepted'; end if;
  -- A shared file survives removal from one post and queues after the last.
  insert into public.community_posts(category_id,title,content,author_id,author_name,attachments)
  select category_value,'__transaction_test__','test',owner_value,'test',attachments from public.community_posts where id=post_value returning id into second_post;
  update public.community_posts set attachments='[]' where id=post_value;
  if exists(select 1 from public.community_image_cleanup_queue where bucket_id='community-files' and object_path=large_path) then raise exception 'Shared file was queued too early'; end if;
  delete from public.community_posts where id=second_post;
  if not exists(select 1 from public.community_image_cleanup_queue where bucket_id='community-files' and object_path=large_path and not_before<=now()) then raise exception 'Last reference removal did not queue cleanup'; end if;
  -- A claimed cleanup lease blocks save/delete races.
  perform * from public.community_claim_storage_cleanup(100);
  rejected := false;
  begin
    update public.community_posts set attachments=jsonb_build_array(jsonb_build_object('path',large_path)) where id=post_value;
  exception when check_violation then rejected := true;
  end;
  if not rejected then raise exception 'Leased object was attached'; end if;
  -- Eight files pass, a ninth is rejected by DB even without the UI/API.
  for index_value in 1..9 loop
    small_path := owner_value::text||'/'||gen_random_uuid()::text||'-test.txt';
    perform public.community_reserve_upload('community-files',small_path,'small.txt',1,owner_value);
    insert into storage.objects(bucket_id,name,metadata) values('community-files',small_path,'{"size":1,"mimetype":"text/plain"}');
    files := files||jsonb_build_array(jsonb_build_object('path',small_path));
    if index_value=8 then update public.community_posts set attachments=files where id=post_value; end if;
  end loop;
  rejected := false;
  begin update public.community_posts set attachments=files where id=post_value;
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'Ninth file was accepted'; end if;
  -- Actual metadata absence is rejected; image bytes do not count toward files.
  rejected := false;
  begin update public.community_posts set attachments='[{"path":"missing"}]' where id=post_value;
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'Missing storage object was accepted'; end if;
  if (select count(*) from public.community_media_metadata('community-files',large_path))<>0 then raise exception 'Removed file remained downloadable'; end if;
end;
$$;
set local role service_role;
select count(*) from public.community_claim_storage_cleanup(1);
select count(*) from public.community_media_metadata('community-files','missing');
reset role;
select 'PASS: exact 25MB, forged metadata, >25MB rejection, 8/9-file boundary, shared refs, delete queue, cleanup lease, missing object and download gate' as verification;
rollback;

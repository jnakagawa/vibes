CREATE OR REPLACE TABLE `operations.campaign_ir_day_v2` AS

WITH
  campaign_data AS (
    SELECT 
       campaignId AS adoffercampaignId,
       budget,
      merchantId,
      min(TIMESTAMP_MILLIS(created)) AS campaign_created_ts,
      max(TIMESTAMP_MILLIS(updated)) AS campaign_updated_ts,
      max(case when active = false then TIMESTAMP_MILLIS(updated) end) as campaign_ended_ts,
      max(active) as active
    FROM `piedotorg-production.analytics_etl.transactions_campaigns`
    group by all
  ),

  base_trx_table as (select
    created_coalesce_ts,
    transactionid,
    anonymous_id,
    case when merchantId = 'verizon' and ifnull(externalSaleValue,0) = 0 then externalCommission else externalSaleValue end as externalSaleValue,
    externalCommission,
    case when merchantId = 'logitechg' then 'logitech' else merchantId end as merchantId,
    adofferid,
adoffercampaignId,
    subsrc, userId, type,
 budgetusedinmillipoints, millipoints,
 campaign_created_ts,
 campaign_ended_ts,
 active,
  lower(adOfferType) as transaction_type,
 -- active,
     FROM `piedotorg-production.data_science.transactions_expanded_view`
    --  inner join campaign_data
    --  using(merchantid)
    --  where ((created_coalesce_ts between campaign_created_ts and campaign_ended_ts)
    --  or (created_coalesce_ts >= campaign_created_ts and active = true)
     )
  ,

  base_shows_clicks_cte as (
select transaction_type, action, merchant_id, anonymous_id, user_id userId, offer_id, campaign_id, adoffercampaignId,budget, timestamp, 
 from 
    `extension_production_views.ext_rewards_transaction` --@cursor - this cte should be replaced with piedotorg-production.intent_engine.offer_expanded_view
         inner join campaign_data
     on campaign_id = adoffercampaignID and merchant_id = merchantId -- earlier versions didn't have campaignId - so those won't work here
    where surface = 'rewards_transaction_popup'
    AND transaction_type IN ('search','retargeting', 'login_search', 'login_retargeting') -- want to track login shows as well 
  ),

  shows_clicks AS (
  SELECT
    DATE(TIMESTAMP_TRUNC(timestamp, day)) AS dt,
    transaction_type,
    merchant_id,
  adoffercampaignId,
  budget,
    --anonymous_id
    count(distinct if(action = 'show',anonymous_id,null)) as show_users,
    count(distinct if(action = 'click',anonymous_id,null) )as click_users,
    count(distinct if(action = 'login',anonymous_id,null) )as login_action_user,
    count(if(action = 'show',anonymous_id,null)) as shows,
    count( if(action = 'click',anonymous_id,null)) as clicks,
  FROM
     base_shows_clicks_cte
  WHERE
   true
    group by all

    ),

direct_aff_cte as  (

select 
DATE(TIMESTAMP_TRUNC(created_coalesce_ts, day)) AS dt,
case when subsrc = 'pie_offer_search' or subsrc = "pie_offer_login_search" then 'search'
     when subsrc = 'pie_offer_retargeting' then 'retargeting'
     else null end transaction_type,
     adoffercampaignId,
  count(*) as  offer_aff_trx,
  count(distinct userid) as trx_users,
  count(distinct transactionID) as dist_trx_offer_aff,
  --substr("pie_offer_login_retargeting", 17) as transaction_type,
  sum(externalSaleValue)/100 as gmv_dollars,
  sum(externalCommission)/100 as commission_dollars,
  merchantId as merchant_id

   FROM (
  select a.transactionid, externalSaleValue, externalCommission, subsrc,
    a.created_coalesce_ts, a.userId, a.merchantId, type, anonymous_id, offer.transaction_type, 
    offer.adofferCampaignId,
    row_number() over (partition by transactionId) as trx_id_row
    from base_trx_table a
    inner join -- join to the trx which are offers
    (select userId, created_coalesce_ts, merchantid, transaction_type, adofferCampaignId--,campaign_ended_ts
    from base_trx_table b
     where type = "AD_OFFER" and adoffercampaignID is not null) offer on a.userId = offer.userid and a.merchantid = offer.merchantid
     and a.created_coalesce_ts between offer.created_coalesce_ts and ifnull(campaign_ended_ts, current_timestamp()) --and offer.campaign_ended_ts -- try this see if it helps accuracy
     and subsrc in ("pie_offer_search","pie_offer_retargeting", "pie_offer_login_search" )
    )
     where type = "AFFILIATE" and trx_id_row = 1 
    -- FROM base_trx_table a 
    -- inner join -- join to the trx which are offers
    -- (select userId, created_coalesce_ts, merchantid, transaction_type, adofferCampaignId--,campaign_ended_ts
    -- from base_trx_table b
    --  where type = "AD_OFFER" and adoffercampaignID is not null) offer on a.userId = offer.userid and a.merchantid = offer.merchantid and 
    --  a.created_coalesce_ts >= offer.created_coalesce_ts
    --  where
    --     -- subsrc in ("pie_offer_login_search", "pie_offer_login_retargeting","rewards_transaction_popup","pie_offer_search","pie_offer_retargeting") 
    --     subsrc in ("pie_offer_search","pie_offer_retargeting", "pie_offer_login_search" )
    --  and type = "AFFILIATE"
    group by all

),

click_aff_cte_24h as (
  
  select 
DATE(TIMESTAMP_TRUNC(created_coalesce_ts, day)) AS dt,
transaction_type,
adoffercampaignId,
  count(*) as  offer_aff_trx_24h,
  count(distinct anonymous_id) as trx_users_24h,
  count(distinct transactionID) as dist_trx_24h,
  --substr("pie_offer_login_retargeting", 17) as transaction_type,
  sum(externalSaleValue)/100 as gmv_dollars_24h,
  sum(externalCommission)/100 as commission_dollars_24h,
  merchantId as merchant_id
 FROM (
  select a.transactionid, externalSaleValue, externalCommission, subsrc,
    a.created_coalesce_ts, a.userId, a.merchantId, type, anonymous_id, offer.transaction_type, 
    offer.adofferCampaignId,
    row_number() over (partition by transactionId) as trx_id_row
    from base_trx_table a
    inner join -- join to the trx which are offers
    (select userId, created_coalesce_ts, merchantid, transaction_type, adofferCampaignId--,campaign_ended_ts
    from base_trx_table b
     where type = "AD_OFFER" and adoffercampaignID is not null) offer on a.userId = offer.userid and a.merchantid = offer.merchantid
     and timestamp_diff(a.created_coalesce_ts,offer.created_coalesce_ts, hour) between 0 and 24 and a.created_coalesce_ts >= offer.created_coalesce_ts --and offer.campaign_ended_ts -- try this see if it helps accuracy
    -- and subsrc not in ("pie_offer_login_search", "pie_offer_login_retargeting","rewards_transaction_popup","pie_offer_search","pie_offer_retargeting","rewards_popup") 
    )
     where type = "AFFILIATE" and trx_id_row = 1 
    group by all
),

click_aff_cte_7d as  (
  select 
DATE(TIMESTAMP_TRUNC(created_coalesce_ts, day)) AS dt,
  count(*) as  offer_aff_trx_click_7d,
  count(distinct anonymous_id) as trx_users_click_7d,
  count(distinct transactionID) as dist_trx_click_7d,
  --substr("pie_offer_login_retargeting", 17) as transaction_type,
  sum(externalSaleValue)/100 as gmv_dollars_click_7d,
  sum(externalCommission)/100 as commission_dollars_click_7d,
  transaction_type,
  merchantId as merchant_id,
  adofferCampaignId
 FROM (select a.transactionid, externalSaleValue, externalCommission, subsrc,
    a.created_coalesce_ts, a.userId, a.merchantId, type, anonymous_id, offer.transaction_type,
offer.adofferCampaignId,
     row_number() over (partition by transactionId) as trx_id_row from 
    base_trx_table a inner join
    (select userId, created_coalesce_ts,merchantid, transaction_type,adofferCampaignId from base_trx_table  where type = "AD_OFFER"  and adoffercampaignID is not null) offer on a.userId = offer.userid and a.merchantid = offer.merchantid
     and timestamp_diff(a.created_coalesce_ts,offer.created_coalesce_ts, day) between 0 and 7 and a.created_coalesce_ts >= offer.created_coalesce_ts
     --and subsrc not in ("pie_offer_login_search", "pie_offer_login_retargeting","rewards_transaction_popup","pie_offer_search","pie_offer_retargeting","rewards_popup") 
    )
     where type = "AFFILIATE" and trx_id_row = 1 
    group by all
),
view_aff_cte as 
(select 
DATE(TIMESTAMP_TRUNC(created_coalesce_ts, day)) AS dt,
transaction_type,
adofferCampaignId,
  count(*) as  view_aff_trx,
  count(distinct userid) as trx_users_view,
  count(distinct transactionID) as dist_trx_view,
  --substr("pie_offer_login_retargeting", 17) as transaction_type,
  sum(externalSaleValue)/100 as gmv_dollars_view,
  sum(externalCommission)/100 as commission_dollars_view,
  merchantId as merchant_id
    FROM (select a.transactionid, externalSaleValue, externalCommission, subsrc,
    a.created_coalesce_ts, a.userId, anonymous_id, a.merchantId, type, view.transaction_type, 
    view.adofferCampaignId,
    row_number() over (partition by transactionId) as trx_id_row from 
    base_trx_table a inner join
     (select userId, timestamp, merchant_id,transaction_type, adofferCampaignId, from base_shows_clicks_cte  where action ="show" ) view
     on a.userId = view.userid and a.merchantid = view.merchant_id
     and timestamp_diff(a.created_coalesce_ts,  view.timestamp, hour) between 0 and 24 and a.created_coalesce_ts >= view.timestamp
       -- subsrc not in ("pie_offer_login_search", "pie_offer_login_retargeting","rewards_transaction_popup","pie_offer_search","pie_offer_retargeting" )
)
 where type = "AFFILIATE"  
 and trx_id_row = 1 
    group by all

),

view_aff_cte_7d as (
  
select 
DATE(TIMESTAMP_TRUNC(created_coalesce_ts, day)) AS dt,
transaction_type,
adofferCampaignId,
  count(*) as  view_aff_trx_7d,
  --anonymous_id,
 -- userId,
  count(distinct userid) as trx_users_view_7d,
  count(distinct transactionID) as dist_trx_view_7d,
  --substr("pie_offer_login_retargeting", 17) as transaction_type,
  sum(externalSaleValue)/100 as gmv_dollars_view_7d,
  sum(externalCommission)/100 as commission_dollars_view_7d,
  merchantId as merchant_id
    FROM (select a.transactionid, externalSaleValue, externalCommission, subsrc, view.adofferCampaignId,
    a.created_coalesce_ts, a.userId, merchantId, type, view.transaction_type, row_number() over (partition by transactionId) as trx_id_row from 
    base_trx_table a inner join (select userId, adofferCampaignId, timestamp,merchant_id,transaction_type from base_shows_clicks_cte  where action ="show" ) view
     on a.userId = view.userid and a.merchantid = view.merchant_id
     and timestamp_diff(a.created_coalesce_ts,  view.timestamp, day) between 0 and 7 and created_coalesce_ts >= view.timestamp
       -- subsrc not in ("pie_offer_login_search", "pie_offer_login_retargeting","rewards_transaction_popup","pie_offer_search","pie_offer_retargeting" )
) where type = "AFFILIATE"  
 and trx_id_row = 1 
    group by all
    
),

checkouts_24h_join as (

select transaction_type, a.timestamp, a.merchant_id ,a.anonymous_id, action, id, b.adofferCampaignId, row_number() over (partition by id) as id_row_num from 
     `extension_production_views.ext_order_confirmation` a  inner join  base_shows_clicks_cte b 
    on a.anonymous_id = b.anonymous_id and a.merchant_id = b.merchant_id and timestamp_diff(a.timestamp, b.timestamp, hour) between 0 and 24 and a.timestamp>=b.timestamp
inner join campaign_data
on a.merchant_id = campaign_data.merchantid
 and ((a.timestamp between campaign_data.campaign_created_ts and campaign_data.campaign_ended_ts)
 or (a.timestamp >= campaign_data.campaign_created_ts and active = true))

),

checkouts_7d_join as (

select transaction_type, a.timestamp, a.merchant_id ,a.anonymous_id, action, id, b.adofferCampaignId, row_number() over (partition by id) as id_row_num from 
     `extension_production_views.ext_order_confirmation` a  inner join  base_shows_clicks_cte b 
    on a.anonymous_id = b.anonymous_id and a.merchant_id = b.merchant_id and timestamp_diff(a.timestamp, b.timestamp, hour) between 0 and 168 and a.timestamp>=b.timestamp
inner join campaign_data
on a.merchant_id = campaign_data.merchantid
 and ((a.timestamp between campaign_data.campaign_created_ts and campaign_data.campaign_ended_ts)
 or (a.timestamp >= campaign_data.campaign_created_ts and active = true))

),

checkouts_24h AS (

SELECT
    --timestamp AS checkout_ts,
    DATE(TIMESTAMP_TRUNC(a.timestamp, day)) AS dt,
    transaction_type,
       a.merchant_id,   
       adofferCampaignId,
count(distinct a.anonymous_id) as checkout_users_24h,
count(  (if(action = "click" ,anonymous_id,null) ))as rewards_click_checkout_24h,
count( (if(action = "show" ,anonymous_id,null) ))as rewards_view_checkout_24h,
count( distinct (if(action = "click" ,anonymous_id,null) ))as rewards_click_checkout_users_24h,
count( distinct (if(action = "show" ,anonymous_id,null) ))as rewards_view_checkout_users_24h,
count(a.anonymous_id) as num_checkouts_24h
  FROM
   checkouts_24h_join a where id_row_num = 1

group by all

),

checkouts_7d AS (

SELECT
    --timestamp AS checkout_ts,
    DATE(TIMESTAMP_TRUNC(a.timestamp, day)) AS dt,
    transaction_type,
       a.merchant_id,   
       adofferCampaignId,
count(distinct a.anonymous_id) as checkout_users_7d,
count(  (if(action = "click" ,anonymous_id,null) ))as rewards_click_checkout_7d,
count( (if(action = "show" ,anonymous_id,null) ))as rewards_view_checkout_7d,
count( distinct (if(action = "click" ,anonymous_id,null) ))as rewards_click_checkout_users_7d,
count( distinct (if(action = "show" ,anonymous_id,null) ))as rewards_view_checkout_users_7d,
count(a.anonymous_id) as num_checkouts_7d
  FROM
   checkouts_7d_join a where id_row_num = 1

group by all

),

base_trx_cte as (

SELECT 
  SUM(millipoints)/100000 AS dollars_awarded,
  sum(budgetUsedInMillipoints)/1000/100 as budget_used,
  --adoffercampaignId,
  sum(if(adoffercampaignId is not null, millipoints,0))/100000  as campaign_dollars_awarded,
  count(*) as unique_rewards,
  count(distinct userid) as claimed_users,
  transaction_type,
  date(created_coalesce_ts) as dt,
  --subsrc,
  merchantId as merchant_id,
  adofferCampaignId
 FROM base_trx_table
 where type = "AD_OFFER"
  and adoffercampaignID is not null
  group by all

 ),

aggregated AS (
SELECT
  dt,
  merchant_id,
  adoffercampaignId,
  budget,
  transaction_type,
  shows,
  clicks,
  dollars_awarded,
  budget_used,
  campaign_dollars_awarded,
  -- direct
  offer_aff_trx AS transactions_direct,
  trx_users as transactions_users_direct,
  gmv_dollars AS gmv_direct,
  commission_dollars AS commission_direct,
  -- click 24h
  offer_aff_trx_24h as transactions_click_24h,
  trx_users_24h as transactions_users_click_24h,
  gmv_dollars_24h as gmv_click_24h,
  commission_dollars_24h as commission_click_24h,
  -- click 7d
  offer_aff_trx_click_7d as transactions_click_7d,
  trx_users_click_7d as transactions_users_click_7d,
  gmv_dollars_click_7d as gmv_click_7d,
  commission_dollars_click_7d as commission_click_7d,
  -- view 24h
  view_aff_trx as transactions_view_24h,
  trx_users_view as transactions_users_view_24h,
  gmv_dollars_view as gmv_view_24h,
  commission_dollars_view as commission_view_24h,
  -- view 7d
  view_aff_trx_7d as transactions_view_7d,
  trx_users_view_7d as transactions_users_view_7d,
  gmv_dollars_view_7d as gmv_view_7d,
  commission_dollars_view_7d as commission_view_7d,
  -- click checkouts
  rewards_click_checkout_24h as checkouts_click_24h,
  rewards_click_checkout_users_24h as checkouts_users_click_24h,
  rewards_click_checkout_7d as checkouts_click_7d,
  rewards_click_checkout_users_7d as checkouts_users_click_7d,
  -- view checkouts
  rewards_view_checkout_24h as checkouts_view_24h,
  rewards_view_checkout_users_24h as checkouts_users_view_24h,
  rewards_view_checkout_7d as checkouts_view_7d,
  rewards_view_checkout_users_7d as checkouts_users_view_7d
FROM
  shows_clicks
FULL OUTER JOIN base_trx_cte USING (dt, merchant_id, adoffercampaignId, transaction_type)
FULL OUTER JOIN direct_aff_cte USING (dt, merchant_id, transaction_type, adoffercampaignId)
FULL OUTER JOIN checkouts_24h USING (dt, merchant_id, transaction_type, adoffercampaignId)
FULL OUTER JOIN checkouts_7d USING (dt, merchant_id, transaction_type, adoffercampaignId)
FULL OUTER JOIN click_aff_cte_24h USING (dt, merchant_id, transaction_type, adoffercampaignId)
FULL OUTER JOIN view_aff_cte USING (dt, merchant_id, transaction_type, adoffercampaignId)
FULL OUTER JOIN view_aff_cte_7d USING (dt, merchant_id, transaction_type, adoffercampaignId)
FULL OUTER JOIN click_aff_cte_7d USING (dt, merchant_id, transaction_type, adoffercampaignId)
GROUP BY ALL
)
select distinct  * from aggregated

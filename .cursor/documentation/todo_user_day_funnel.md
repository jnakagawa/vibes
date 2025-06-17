# Data Pipeline Implementation Plan - User Day Funnel

## Source Layer Tables
- [x] Create source definitions for all referenced tables:
  - `ext_heartbeat`, `ext_session_started`, `ext_context_detect`
  - `ext_savings`, `ext_affiliate_tag`, `ext_order_confirmation`
  - `ext_standdown_detected`, `ext_device_ad_metrics_rollup`
  - `ext_rewards_transaction`, `ext_user_settings`
  - `outbound_redirect`, `transactions_affiliatetransactions`
  - `transactions_expanded_view`, `installs_base`, `user_balances`
  - `web_server_uninstall`, `web_uninstall`

## Feature Layer Tables (Dataset: `user_features`)
- [x] `f_user_heartbeats` - INCREMENTAL
  - Daily heartbeat aggregations + device tracking
  - Includes app versions, extension status
  - Source: ext_heartbeat

- [x] `f_user_sessions` - INCREMENTAL  
  - Session and cart activities
  - Non-pie sessions, cart visits
  - Sources: ext_session_started, ext_context_detect

- [x] `f_user_interactions` - INCREMENTAL
  - Clicks, shows, savings interactions
  - Popover interactions, coupon actions
  - Source: ext_savings

- [x] `f_user_transactions` - INCREMENTAL
  - All transaction types with details
  - Revenue, millipoints, transaction status
  - Source: transactions_expanded_view

- [x] `f_user_commerce` - INCREMENTAL
  - Tags, confirmations, redirects
  - Affiliate tracking, conversion events
  - Sources: ext_affiliate_tag, ext_order_confirmation, outbound_redirect

- [x] `f_user_installs` - INCREMENTAL
  - Install/uninstall events by date
  - Extension types, install counts
  - Sources: installs_base, web_server_uninstall, web_uninstall

- [x] `f_user_identity` - FULL REFRESH (needs historical context)
  - User app assignment + context resolution
  - Country/UA resolution from installs & heartbeats
  - Requires full history for proper assignment

- [x] `f_user_events` - INCREMENTAL
  - Standdowns, ad metrics, user settings
  - Other daily event aggregations
  - Sources: ext_standdown_detected, ext_device_ad_metrics_rollup, etc.

## Intermediate Layer (Dataset: `user_intermediate`)
- [x] `int_user_daily_base` - INCREMENTAL
  - Core daily user aggregations
  - Joins feature tables by anonymous_id + dt

- [x] `int_transaction_mapping` - FULL REFRESH (transaction linking)
  - Maps transactions to anonymous IDs
  - Requires full history for proper linking
  - Sources: transactions_affiliatetransactions + outbound_redirect

- [x] `int_user_cohort_logic` - FULL REFRESH (cohort calculations)
  - Cohort date calculations, days since cohort
  - Requires full history for proper cohort assignment

## Final Layer (Dataset: `users`)
- [x] `user_day_funnel` - INCREMENTAL
  - Final comprehensive user day funnel
  - Combines all intermediate layers
  - 3-hour refresh schedule

## Configuration & Infrastructure
- [ ] Set up dataset configurations (user_features, user_intermediate, users)
- [ ] Configure incremental processing logic for appropriate tables
- [ ] Set up scheduling configuration (3-hour intervals)
- [ ] Add table partitioning settings
- [ ] Configure dependencies between layers

## Testing Steps (New)
- [ ] Initialize dataform project
  - Set up project config
  - Configure BigQuery credentials
  - Set up staging dataset

- [ ] Dry run validation
  - Test f_user_sessions compilation
  - Test agg_user_daily_metrics compilation
  - Validate ROLLUP/CUBE results
  - Check partitioning setup

- [ ] Production deployment
  - Deploy to staging dataset
  - Verify initial data load
  - Confirm scheduling setup

## Documentation
- [ ] Add table descriptions and column documentation
- [ ] Document aggregation logic and ROLLUP/CUBE usage
- [ ] Add sample queries for common use cases

## Future Considerations (Not Implementing Now)
- [ ] User filtering capabilities (fraud, test accounts)
- [ ] Activity scoring
- [ ] Hourly aggregations
- [ ] Custom date range aggregations 
# Dataform Project Structure

## Root Files
- `README.md` - Project documentation
- `todo.md` - Implementation plan and progress tracking
- `workflow_settings.yaml` - Dataform workflow configuration
- `test_mcp.sql` - MCP connection testing
- `user_day_funnel_source.sql` - Source query file
- `.gitignore` - Git ignore rules

## Configuration Directory
- `.cursor/` - Cursor IDE configuration
  - `mcp.json` - MCP servers configuration
  - `rules/rules.md` - Project coding guidelines
  - `tools.md` - Available tools documentation
  - `project_structure.md` - This file

## Definitions Directory
- `definitions/` - Dataform table definitions
  - Source layer tables (ext_*)
  - Feature layer tables (f_*)
  - Intermediate layer tables (int_*)
  - Final layer tables (user_*)
  - `unified_user_feedback.sqlx` - **RECENTLY UPDATED**: Fixed user app assignment logic

## Datasets Structure
- **Sources**: Raw external data
- **user_features**: Feature layer aggregations  
- **user_intermediate**: Intermediate processing
- **users**: Final user funnel tables
- **data_science**: Analytics and feedback tables

## Data Flow
```
Sources → user_features → user_intermediate → users
```

## Key Tables
- `user_day_funnel` - Main comprehensive user activity table
- Feature tables: `f_user_*` (heartbeats, sessions, transactions, etc.)
- Intermediate tables: `int_user_*` (daily base, cohort logic, etc.)
- `unified_user_feedback` - Unified feedback view with **fixed app assignment logic**

## Recent Changes
- **2024**: Fixed user app assignment in `unified_user_feedback` to correctly assign users based on which anonymous_id field contains their ID rather than relying on potentially incorrect extension_type field 
# Available MCP Tools

## BigQuery MCP Server
- **Server**: mcp-server-bigquery
- **Project**: piedotorg-staging  
- **Location**: us-central1
- **Authentication**: GCP credentials (jonah@pie.org)

## Capabilities
- Query BigQuery datasets and tables
- Execute SQL queries
- Inspect table schemas and metadata
- Validate data pipeline logic

## Usage
- Configured through `.cursor/mcp.json`
- Requires proper GCP authentication
- Uses npx with @smithery/cli for server execution

## Troubleshooting
- Ensure GCP auth is active: `gcloud auth list`
- Verify project setting: `gcloud config get-value project`
- Restart Cursor after configuration changes 
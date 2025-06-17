# Dataform Project Rules & Guidelines

## Code Style & Structure
- Use clear, descriptive naming for tables and columns
- Add debug logs and comments for easier debugging and readability
- Follow incremental vs full refresh patterns appropriately
- Use proper dataset organization (source -> features -> intermediate -> final)
- Compile before pushing changes to make sure that the code will run properly

## BigQuery Best Practices
- Use partitioning for large tables
- Optimize queries for performance
- Use proper materialization strategies (INCREMENTAL vs FULL_REFRESH)
- Include proper dependencies between tables

## Documentation
- Add table descriptions and column documentation
- Document aggregation logic clearly
- Include sample queries for common use cases

## MCP Tools Configuration
- BigQuery server configured for piedotorg-staging project
- Use us-central1 location for all operations
- Ensure proper GCP authentication is maintained 

## Main Workflow:

Perform your assigned tasks.

Run:

python3 userinput.py
The terminal should be opened in the chat window itself.

Read the user's input.

Based on the input, perform the next set of tasks.

Repeat the process.

## Exit Condition:

If the user enters "stop" when prompted, exit the loop and terminate the process.

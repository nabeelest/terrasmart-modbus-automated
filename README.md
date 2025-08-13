# Modbus Automated

A Node.js application for generating comprehensive Modbus reports with different sorting modes.

## Environment Setup

### 1. Copy Environment File

Copy the example environment file to create your own `.env` file:

```bash
cp env.example .env
```

### 2. Configure Environment Variables

Edit the `.env` file with your actual values:

#### Required Authentication Variables
- `ACCESS_TOKEN`: Your API access token for authentication
- `XSRF_TOKEN`: Cross-site request forgery token
- `_XSRF_COOKIE`: XSRF cookie value

#### Optional Variables
- `GRAPHQL_URL`: GraphQL endpoint URL (defaults to https://192.168.12.71/graphql)
- `TIMEOUT_MS`: Request timeout in milliseconds (defaults to 8000)
- `COOKIE`: Direct cookie override if needed
- `SITE`: Default site IP/hostname (defaults to 192.168.12.71)
- `VERBOSE`: Enable verbose logging (true/false)

### 3. Install Dependencies

```bash
npm install
```

## Usage

### Generate All Reports

```bash
node generateAllReports.js <site> <ttid_csv_path> <position_csv_path>
```

Example:
```bash
node generateAllReports.js 192.168.12.71 sample_ttids.csv sample_positions.csv
```

### Set Modbus Mode

```bash
node modbus-set-mode-api.js --mode <mode> [--verbose]
```

Available modes:
- `ttid`: TTID sorted mode
- `legacy-unsorted`: Legacy unsorted mode  
- `legacy-sorted`: Legacy sorted mode

Example:
```bash
node modbus-set-mode-api.js --mode ttid --verbose
```

## Report Types

The application generates three types of reports:

1. **TTID Sorted Reports**: Uses TTID-based sorting
2. **Legacy Unsorted Reports**: Legacy mode without sorting
3. **Legacy Sorted Reports**: Legacy mode with sorting

Reports are saved in the `modbus_csv_outputs/` directory with organized subdirectories.

## Security Notes

- Never commit your `.env` file to version control
- Keep your authentication tokens secure
- The `.env` file is already in `.gitignore` to prevent accidental commits
"# terrasmart-modbus-automated" 

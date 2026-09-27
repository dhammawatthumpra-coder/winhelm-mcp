# Contributing to WinHelm

Thank you for your interest in contributing to **WinHelm MCP**! We welcome community contributions, bug reports, feature suggestions, and documentation improvements.

---

## Code of Conduct

Please be respectful, collaborative, and considerate in all interactions.

---

## Development Setup

WinHelm is built with **Node.js 20+** and **TypeScript 5.8+** on Windows.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/<your-username>/winhelm-mcp.git
   cd winhelm-mcp
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run in development mode (with hot-reload):**
   ```bash
   npm run dev
   ```

4. **Run the automated test suite:**
   ```bash
   npm test
   ```

5. **Build TypeScript:**
   ```bash
   npm run build
   ```

6. **Build Standalone Windows Executable (`winhelm.exe`):**
   ```bash
   npm run build:exe
   ```

---

## Guidelines for Contributions

### 1. Karpathy Guidelines & Clean Code
- **Simplicity First**: Write the minimum code needed to solve the problem. Avoid premature abstractions or complex frameworks.
- **Surgical Changes**: Touch only what you need. Preserve existing code style and formatting.
- **Strict TypeScript**: Ensure `npm run build` succeeds with zero errors and zero warnings.

### 2. Native Windows Best Practices
- **UTF-8 Encoding**: All PowerShell command invocations must force UTF-8 console and string encoding.
- **Process Tree Hygiene**: Background processes must be properly cleaned up using process tree termination (`taskkill /pid <pid> /T /F`) to avoid zombie processes.
- **No Third-Party Bloat**: Prefer native Windows PowerShell, .NET Framework APIs, or Node standard library over adding large npm dependencies.

### 3. Testing Requirements
- Every new tool or feature must include automated tests under `test/unit/` or `test/integration/`.
- All tests must pass before opening a Pull Request (`npm test`).

---

## Submitting a Pull Request (PR)

1. Fork the repo and create your branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Commit your changes with clear, descriptive commit messages:
   ```bash
   git commit -m "feat(tools): add disk_usage tool"
   ```
3. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
4. Open a Pull Request on GitHub describing your changes and verification steps.

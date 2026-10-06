# config/ - PRIVATE

Real files here are gitignored. Only `*.example.*` files (a fake persona) are public.

| Example (public) | Real file (private) |
|---|---|
| cv.example.md | cv.md |
| answers.example.yaml | answers.yaml |
| salary.example.yaml | salary.yaml |
| companies.example.yaml | companies.yaml |
| private-patterns.example.txt | private-patterns.txt |

Agents read the real files, never edit them, and never copy their content into committed files.
Tests and fixtures use the example files only.

repo: jonastar/server-central
branch: main
path: apps/web/src

## Last sync

date: 2026-08-12T21:22:00Z

### Updated in this project

- Added Apps feature design (list, detail tabs, create/import) matching existing Server Central styling
- Sidebar recreated from Sidebar.tsx + Sidebar.module.css with a new top-level "Apps" item
- Tokens, tables, badges, modals lifted from styles/global.css and styles/shared.module.css

## Screen map

| Screen | Built from |
| --- | --- |
| ScSidebar.dc.html | apps/web/src/components/Sidebar.tsx, Sidebar.module.css, components/ui.tsx (StatusDot) |
| Apps Feature 1a–1c (Apps list) | components/TasksView.tsx, docker/DockerStacks.tsx, StatusFilter.module.css, styles/shared.module.css |
| Apps Feature 1d–1h (App detail tabs) | components/ServerOverview.tsx, CodeEditor.tsx, FilesView.module.css, LogViewer.module.css, shared.module.css (sub-tabs) |
| Apps Feature 1i–1j (detail structures) | components/ServerOverview.tsx, FilesView.module.css |
| Apps Feature 1k–1l (create/import) | components/AddNodeModal.tsx, components/ui.tsx (Modal), ui.module.css, DirectoryPicker.tsx |

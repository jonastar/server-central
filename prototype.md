# Server central

This is a all in one server management and deployment platform, primarily targeted towards homelabs and small-medium size businesses (not trying to handle google level scaling here)

There is a wider plan in homelab-hub-spec.md but i think we should start with something usable and simple first to see whats needed!

So what should be included?

- Manage multiple servers
- Browse files on these servers
- Edit files through monaco/fallback to something more basic on mobile
- Basic metrics with in-process history
  - cpu (per core), memory, network, disk (usage+ read write)
- Terminal
- Docker integration
  - View containers, potentially volumes and whatnot

I think with this alone we cover enough ground to start with.

How i personally envision the frontend design:

- Light themed, but not full white
- Medium information density
- Sidebar, servers in the sidebar and under them items to view their stats, filebrowser, processes, containers, terminal etc...
- A bigger dashboard overview with a card for each server? maybe we can have the server entries in the sidebar also be smart and show some basic info, like IP address and whatnot (along with a indicator light for status/health?)

The project were in now is a stripped down other project of mine, i want to reuse the API layer/networking with the shared types and the defining API schema in typescript types, the rest can go. so make sure to remove everything irrelevant and rename everything to server central (working title)

# Server-central (working title)

Server central is an attempt to make a tool to manage a lot of computers/servers, be it in a homelab, small business or whatever (just don't try to bring this into a enterprise scenario with a 1k+ node cluster, i did not build it for that)

Personally im fed up with how a lot of stuff in this area is just a hassle because the tools you're trying to use are built to do way more than you need it to do. Examples include:

- You just wanna see cpu and memory usage on your cluster, maybe with a historical graph
  - Set up grafana, prometheus, install metrics collector everywhere, configure auth, set up actual dashboard etc...
- Wanna expose a service outside your lan?
  - Now you're entering reverse proxy configuration land with dyn dns and lets encrypt
  - Don't forget to also edit all your stacks with labels or edit text files using right syntax and keywords to get it working
- User management
  - Have fun trying to keep a list of accounts synced across 10 applications

And so on. Now there are some projects which are interesting and covers a lot of bases such as

- Cosmos-Server: The best one i've seen, but it's limited to 1 host.
- Dockhand: I haven't really gone deep into this but it seems like it covers a lot of what i want, except it's centered around docker and forgetting the system around it.
- Portainer: does very little honestly, its just a glorified web frontend for docker.

So the goal of this is a central hub for managing a server/cluster of servers;

## Planned features

- Docker integration (volumes, networks, stacks, etc)
- Easy reverse proxy
  - Start a jellyfin docker stack, and via 1 button press have it be exposed with https
- Networked volumes
  - Have a nas? you should be able to mount it to jellyfin without too much hassle right?
- Basic monitoring and metrics
- User management and SSO across applications
  - Self explanatory
- File browser with file editor
- Terminal
- Wireguard mesh setup and automatic management across your cluster
  - I'm still thinking about this, it might be a dependency on other features such as reverse proxy and network volumes as having a standard flat networking topology managed by server-central would make it much simpler, leave all the networking complexities in the wireguard overlay network layer and stuff can build on top of that you know? Again, still a topic in my brainmind.
- And so on...

The goal is to have stuff work with minimal configuration, or easily configurable, but as a side effect of that i will make opinionated choices here and there, there might be less configuration options available, and things might break if you mess around with stuff manually in docker etc.

**Currently whats implemented is:**

- Single owner account
- Adding nodes
- File browser and editor
- Basic monitoring

So i have a long way to go!

## Potential issues

A central place that has access to all servers is scary, so i need to consider that, luckily since this is the 1 place that is responsible security in your homelab setup we can afford to have it be a "little" annoying with 2fa etc, instead of each of the 10 apps you run trying to handle it themselves in their own cute little ways (and having to log in 10 times as a side effect) (2x effort to log in once vs 1x effort but in 10x apps)

## Vibe coding

Is this vibe coded? kinda, i've used claude heavily but make no mistakes im very opinionated on the architecture. I am the one that's designed the systems and then have had claude implement them (aka do the dirty work if you will)

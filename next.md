# Next items to implement

- Web: Store state in url, e.g the current folder were viewing, the current file were editing, the current open view etc
  - Example: /server/fm/folder/path/here

- Add nodes
  - I was originally thinking of creating a overlay network using wireguard by default, but i think that could be an optional thing
  - To start with we need to figure out a way to connect nodes directly to the control plane
    - Nodes will run an agent that attempts to connect to the control plane
    - Connection will be encrypted, maybe with a public private key exchange?
    - OR would it be better to go right to creating the wireguard network?

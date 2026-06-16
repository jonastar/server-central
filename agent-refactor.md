Abstract the transport away

That way the agent can be something like:

```ts
class Agent {
    isEmbedded: bool, // wheterr this is a remote or embedded (same as control plane) agent

    transport: AgentTransport

    constructor(){

    }

    onMessage(msg: ControlMessage){
        switch(msg.type)....

        this.transport.send({type: ....})
    }
}

```

This means we can have the same agent be invoked for the embedded one that runs on the control plane, and the remote one, no need to duplicate the code!

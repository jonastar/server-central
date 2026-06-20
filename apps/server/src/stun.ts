/**
 * Minimal RFC 5389 STUN binding request to discover the control plane's
 * external IP. Used to embed both LAN and WAN addresses in node install
 * commands so agents can reach the control plane even across NAT.
 */
export async function discoverWanIp(timeoutMs = 3000): Promise<string | null> {
    const txId = crypto.getRandomValues(new Uint8Array(12));
    const req = new Uint8Array(20);
    const view = new DataView(req.buffer);
    view.setUint16(0, 0x0001);       // Binding Request
    view.setUint16(2, 0x0000);       // Message length (no attributes)
    view.setUint32(4, 0x2112A442);   // Magic cookie
    req.set(txId, 8);

    return new Promise(async (resolve) => {
        const timeout = setTimeout(() => {
            try { socket.close(); } catch { }
            resolve(null);
        }, timeoutMs);

        const socket = await Bun.udpSocket({
            socket: {
                data(_sock, data, _port, _addr) {
                    clearTimeout(timeout);
                    try { socket.close(); } catch { }
                    resolve(parseStunResponse(new DataView(data.buffer, data.byteOffset, data.byteLength), txId));
                },
                error(_sock, err) {
                    clearTimeout(timeout);
                    try { socket.close(); } catch { }
                    console.warn("STUN socket error:", err.message);
                    resolve(null);
                },
                drain() { },
            },
        });

        let stunIp: string;
        try {
            const [resolved] = await Bun.dns.lookup("stun.l.google.com", { family: 4 });
            stunIp = resolved.address;
        } catch (err) {
            clearTimeout(timeout);
            try { socket.close(); } catch { }
            console.warn("STUN DNS lookup failed:", (err as Error).message);
            resolve(null);
            return;
        }

        try {
            socket.send(req, 19302, stunIp);
        } catch (err) {
            clearTimeout(timeout);
            try { socket.close(); } catch { }
            console.warn("STUN send failed:", (err as Error).message);
            resolve(null);
        }
    });
}

function parseStunResponse(view: DataView, txId: Uint8Array): string | null {
    if (view.byteLength < 20) {
        return null;
    }

    // Verify magic cookie and transaction ID
    if (view.getUint32(4) !== 0x2112A442) {
        return null;
    }
    for (let i = 0; i < 12; i++) {
        if (view.getUint8(8 + i) !== txId[i]) {
            return null;
        }
    }

    // Walk attributes starting at byte 20
    let offset = 20;
    while (offset + 4 <= view.byteLength) {
        const attrType = view.getUint16(offset);
        const attrLen = view.getUint16(offset + 2);
        offset += 4;

        // 0x0020 = XOR-MAPPED-ADDRESS (preferred), 0x0001 = MAPPED-ADDRESS (fallback)
        if (attrType === 0x0020 || attrType === 0x0001) {
            if (offset + 8 > view.byteLength) {
                break;
            }
            const family = view.getUint8(offset + 1);
            if (family !== 0x01) {
                break; // only IPv4
            }

            const xorIp = view.getUint32(offset + 4);
            const ip = attrType === 0x0020 ? xorIp ^ 0x2112A442 : xorIp;
            return [
                (ip >>> 24) & 0xff,
                (ip >>> 16) & 0xff,
                (ip >>> 8) & 0xff,
                ip & 0xff,
            ].join(".");
        }

        // Attributes are padded to 4-byte boundaries
        offset += Math.ceil(attrLen / 4) * 4;
    }

    return null;
}

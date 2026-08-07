package com.furstfri.llmmobilebridge

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

data class DiscoveredHost(
    val connectionId: String,
    val label: String,
    val host: String,
    val port: Int,
) {
    val url: String get() = "ws://$host:$port"
}

/**
 * Finds machines on the local network by broadcasting a probe. The reply
 * carries no credential, so this can only repair the address of a connection
 * that was already paired — it can never pair a new one.
 */
object NetworkDiscovery {
    const val DEFAULT_PORT = 8766
    private const val PROBE = "{\"llmMobileBridge\":1,\"probe\":true}"
    private const val BROADCAST = "255.255.255.255"

    /** Blocking: call off the main thread. */
    fun probe(port: Int = DEFAULT_PORT, timeoutMs: Int = 1_500): List<DiscoveredHost> {
        val found = LinkedHashMap<String, DiscoveredHost>()
        runCatching {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = timeoutMs
                val payload = PROBE.toByteArray(Charsets.UTF_8)
                socket.send(DatagramPacket(payload, payload.size, InetAddress.getByName(BROADCAST), port))
                val buffer = ByteArray(2048)
                val deadline = System.currentTimeMillis() + timeoutMs
                while (System.currentTimeMillis() < deadline) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    val received = runCatching { socket.receive(packet) }
                    if (received.isFailure) break
                    val sender = packet.address?.hostAddress ?: continue
                    val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    parseAnnouncement(text, sender)?.let { host -> found[host.connectionId] = host }
                }
            }
        }
        return found.values.toList()
    }

    fun parseAnnouncement(raw: String, host: String): DiscoveredHost? {
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        if (json.optInt("llmMobileBridge") != 1) return null
        val connectionId = json.optString("connectionId")
        val port = json.optInt("port")
        if (connectionId.isBlank() || port <= 0 || host.isBlank()) return null
        return DiscoveredHost(
            connectionId = connectionId,
            label = json.optString("label"),
            host = host,
            port = port,
        )
    }

    /**
     * Only a plain `ws://` pairing is repaired. A relay pairing reaches the
     * host through a domain and TLS, and a LAN address would be a downgrade.
     */
    fun shouldHeal(existing: String, discovered: String): Boolean =
        existing.startsWith("ws://", ignoreCase = true) && !existing.equals(discovered, ignoreCase = true)
}

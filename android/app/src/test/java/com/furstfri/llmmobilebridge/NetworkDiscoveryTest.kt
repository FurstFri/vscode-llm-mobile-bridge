package com.furstfri.llmmobilebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkDiscoveryTest {
    @Test
    fun readsAnAnnouncementAndAddressesItByTheSenderAddress() {
        val host = NetworkDiscovery.parseAnnouncement(
            """{"llmMobileBridge":1,"connectionId":"window-1","label":"Домашний ПК","port":8765}""",
            "192.168.1.42",
        )

        assertEquals("window-1", host?.connectionId)
        assertEquals("Домашний ПК", host?.label)
        assertEquals("ws://192.168.1.42:8765", host?.url)
    }

    @Test
    fun rejectsAnnouncementsThatCannotBeTrusted() {
        val noise = listOf(
            "",
            "not json",
            """{"connectionId":"a","port":8765}""",
            """{"llmMobileBridge":2,"connectionId":"a","port":8765}""",
            """{"llmMobileBridge":1,"connectionId":"","port":8765}""",
            """{"llmMobileBridge":1,"connectionId":"a","port":0}""",
        )
        noise.forEach { assertNull(it, NetworkDiscovery.parseAnnouncement(it, "192.168.1.42")) }
    }

    @Test
    fun healsOnlyPlainWebSocketPairings() {
        // A relay pairing reaches the host over TLS; a LAN address is a downgrade.
        assertTrue(NetworkDiscovery.shouldHeal("ws://192.168.1.9:8765", "ws://192.168.1.42:8765"))
        assertFalse(NetworkDiscovery.shouldHeal("wss://bridge.example.com", "ws://192.168.1.42:8765"))
        assertFalse(NetworkDiscovery.shouldHeal("ws://192.168.1.42:8765", "ws://192.168.1.42:8765"))
    }
}

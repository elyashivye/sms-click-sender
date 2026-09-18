package com.smsclicksender.app

import kotlin.random.Random

/**
 * Shared by SyncWorker (background sync) and MainActivity's manual
 * foreground send, so the delay between messages behaves the same
 * regardless of which path is sending.
 */
object SendTiming {
    fun jitteredDelayMs(delaySeconds: Double): Long {
        val base = delaySeconds.coerceAtLeast(0.0) * 1000
        val jitter = base * 0.2 * (Random.nextDouble() * 2 - 1)
        return (base + jitter).toLong().coerceAtLeast(500L)
    }
}

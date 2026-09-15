// Fetches member lists for a set of WhatsApp groups (selected after
// listGroupChats()) and merges them into one deduped contacts list, in the
// same onUpdate/snapshot progress-callback shape as SendJob and
// SaveContactsJob so the UI can reuse the same kind of progress bar/table.

import { AdbError, fetchGroupMembers } from "./adb-client.js";

export class WhatsAppGroupsImportJob {
  constructor(groupNames, config) {
    this.groupNames = groupNames;
    this.config = config; // { adb }
    this.status = "pending"; // pending -> running -> done | cancelled
    this.results = []; // per-group: { group, ok, count, error }
    this.contacts = []; // merged, deduped by phone number: [{ name, phone, group }]
    this.cancelRequested = false;
    this._listeners = new Set();
  }

  onUpdate(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    const snapshot = this.snapshot();
    for (const listener of this._listeners) listener(snapshot);
  }

  snapshot() {
    return {
      status: this.status,
      total: this.groupNames.length,
      completed: this.results.length,
      results: [...this.results],
      contacts: [...this.contacts],
    };
  }

  cancel() {
    this.cancelRequested = true;
  }

  async run() {
    this.status = "running";
    this._notify();

    const { adb } = this.config;
    const seenPhones = new Set();

    for (const groupName of this.groupNames) {
      if (this.cancelRequested) {
        this.status = "cancelled";
        this._notify();
        return;
      }

      try {
        const members = await fetchGroupMembers(adb, groupName);
        let added = 0;
        for (const member of members) {
          if (seenPhones.has(member.phone)) continue;
          seenPhones.add(member.phone);
          this.contacts.push({ ...member, group: groupName });
          added += 1;
        }
        this.results.push({ group: groupName, ok: true, count: added });
      } catch (err) {
        this.results.push({
          group: groupName,
          ok: false,
          error: err instanceof AdbError ? err.message : String(err?.message || err),
        });
      }

      this._notify();
    }

    if (this.status === "running") {
      this.status = "done";
      this._notify();
    }
  }
}

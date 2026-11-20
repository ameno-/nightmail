//! An authenticated adapter is scoped to **one inbox**. UIDs are local to a folder;
//! content and ordinary flags belong to the membership, but Deleted belongs to the entry.
use chrono::{DateTime, FixedOffset};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub type Flags = BTreeSet<String>;
pub type Date = DateTime<FixedOffset>;
#[derive(Clone)]
pub struct Entry {
    pub size: usize,
    pub uid: u32,
    pub id: u64,
    pub raw: Arc<[u8]>,
    pub date: Date,
    pub flags: Flags,
    pub modseq: u64,
}
#[derive(Clone)]
pub struct Folder {
    pub counts: Option<(usize, usize)>,
    pub validity: u32,
    pub next: u32,
    pub highest: u64,
    pub entries: Vec<Entry>,
    pub subscribed: bool,
    pub role: Option<&'static str>,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("[UNAVAILABLE] Backend unavailable")]
    Unavailable,
    #[error("[NONEXISTENT] No such mailbox")]
    Missing,
    #[error("[ALREADYEXISTS] Mailbox exists")]
    Exists,
    #[error("[CANNOT] Not permitted")]
    Denied,
    /// A valid command the store refuses (an invalid or protected folder name, a keyword it can't keep): NO, not BAD.
    #[error("[CANNOT] Not permitted")]
    Cannot,
    #[error("[LIMIT] Inbox limit exceeded")]
    Limit,
    /// The inbox's own storage quota (RFC 9208).
    #[error("[OVERQUOTA] Inbox storage quota exceeded")]
    OverQuota,
    /// The inbox's fair-use download allowance (per UTC day or month) is spent.
    #[error("[LIMIT] Daily download limit reached")]
    DownloadLimit,
    /// A batched change stopped after some batches committed. The command reports what is
    /// now true for its targets, then fails.
    #[error("[UNAVAILABLE] Interrupted after part of the command was applied")]
    Partial,
}
pub enum Change<'a> {
    Append {
        raw: &'a [u8],
        date: Date,
        flags: Flags,
        source: Origin,
    },
    /// With a MODSEQ (STORE UNCHANGEDSINCE, RFC 7162 3.1.3), messages changed after it are left alone and named in
    /// Applied::modified.
    Flags(&'a [u32], Mode, Flags, Option<u64>),
    Transfer(&'a [u32], &'a str, bool),
    Expunge(Option<&'a [u32]>),
}
#[derive(Clone, Copy)]
pub enum Origin {
    Client { now: Date },
    Submission,
}
pub enum Mode {
    Add,
    Remove,
    Replace,
}
pub enum FolderOp<'a> {
    Create,
    Delete,
    Rename(&'a str),
    Subscribe(bool),
}
/// An inbox's storage (bytes) and messages, used and allowed (RFC 9208); None: no limit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quota {
    pub bytes: u64,
    pub messages: u64,
    pub max_bytes: Option<u64>,
    pub max_messages: Option<u64>,
}
pub struct Applied {
    pub validity: u32,
    pub pairs: Vec<(u32, u32)>,
    /// The UIDs a conditional flag change left alone.
    pub modified: Vec<u32>,
}

pub trait MailStore {
    fn prefetch(&self, _path: &str, uids: &[u32]) -> Result<usize, Error> {
        Ok(uids.len())
    }
    /// UIDs whose decoded header field contains `term` (any case), from the store's own index; None: no index, so
    /// SEARCH reads the headers.
    fn indexed(
        &self,
        _path: &str,
        _field: crate::search::Field,
        _term: &str,
    ) -> Result<Option<Vec<u32>>, Error> {
        Ok(None)
    }
    /// A long response so far, for the store to send on now (it takes the bytes); a store that can't keeps them.
    fn flush(&self, _out: &mut Vec<u8>) -> Result<(), Error> {
        Ok(())
    }
    fn list_fresh(&mut self) -> Result<(), Error> {
        Ok(())
    }
    fn select(&mut self, _path: &str) -> Result<(), Error> {
        Ok(())
    }
    fn header(&self, path: &str, e: &Entry) -> Result<Entry, Error> {
        self.materialize(path, e)
    }
    fn budget(&self) -> Result<(), Error> {
        Ok(())
    }
    fn materialize(&self, _path: &str, entry: &Entry) -> Result<Entry, Error> {
        Ok(entry.clone())
    }
    /// The UIDs expunged from a folder after a MODSEQ (RFC 7162 QRESYNC), or None when the store can't tell.
    fn vanished(&self, _path: &str, _since: u64) -> Result<Option<Vec<u32>>, Error> {
        Ok(None)
    }
    /// The inbox's quota (RFC 9208), or None when the store can't tell.
    fn quota(&self) -> Result<Option<Quota>, Error> {
        Ok(None)
    }
    /// A folder's \Deleted messages and their bytes when the store doesn't hold its messages (STATUS DELETED and
    /// DELETED-STORAGE); None: they are counted from the folder's own.
    fn deleted(&self, _path: &str) -> Result<Option<(u64, u64)>, Error> {
        Ok(None)
    }
    fn folders(&self) -> Vec<String>;
    fn folder(&self, path: &str) -> Result<&Folder, Error>;
    fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error>;
    /// Atomic, with one inbox-wide MODSEQ. Returns the destination UID mapping for UIDPLUS.
    fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error>;
}
/// What the memory store keeps in all.
const MEMORY_BYTES: usize = 128 << 20;
pub struct Memory {
    folders: BTreeMap<String, Folder>,
    seq: u64,
    validity: u32,
    submitted: BTreeMap<String, (Date, u32)>,
    /// Expunged (UID, MODSEQ) per folder, oldest first, for QRESYNC. At most 5000 are kept; the first number is the
    /// MODSEQ of the newest one dropped, below which the list is incomplete.
    gone: BTreeMap<String, (u64, Vec<(u32, u64)>)>,
}
impl Default for Memory {
    fn default() -> Self {
        let mut m = Self {
            folders: BTreeMap::new(),
            seq: 1,
            validity: 0,
            submitted: Default::default(),
            gone: BTreeMap::new(),
        };
        for (i, name) in ["INBOX", "Sent", "Drafts", "Archive", "Junk", "Trash"]
            .into_iter()
            .enumerate()
        {
            m.validity += 1;
            m.folders.insert(
                name.into(),
                Folder {
                    counts: None,
                    validity: m.validity,
                    next: 1,
                    highest: 1,
                    entries: vec![],
                    subscribed: true,
                    role: [
                        None,
                        Some("\\Sent"),
                        Some("\\Drafts"),
                        Some("\\Archive"),
                        Some("\\Junk"),
                        Some("\\Trash"),
                    ][i],
                },
            );
        }
        m
    }
}
impl Memory {
    pub fn revision(&self) -> u64 {
        self.seq
    }
    fn bury(&mut self, path: &str, uids: impl IntoIterator<Item = u32>, seq: u64) {
        let (floor, list) = self.gone.entry(path.into()).or_default();
        list.extend(uids.into_iter().map(|u| (u, seq)));
        if list.len() > 5000 {
            let cut = list.len() - 5000;
            *floor = list[cut - 1].1;
            list.drain(..cut);
        }
    }
}
impl MailStore for Memory {
    fn folders(&self) -> Vec<String> {
        self.folders.keys().cloned().collect()
    }
    fn folder(&self, path: &str) -> Result<&Folder, Error> {
        self.folders.get(path).ok_or(Error::Missing)
    }
    fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
        fn valid(s: &str) -> bool {
            !s.is_empty()
                && s.len() <= 255
                && s.is_ascii()
                && s.bytes().all(|b| (32..127).contains(&b))
                && s.split('/').all(|p| !p.is_empty())
                && s.split('/').count() <= 16
        }
        self.seq += 1;
        match op {
            FolderOp::Create => {
                if !valid(path) {
                    return Err(Error::Cannot);
                }
                if self.folders.contains_key(path) {
                    return Err(Error::Exists);
                }
                if self.folders.len() >= 1000 {
                    return Err(Error::Limit);
                }
                self.validity = self.validity.checked_add(1).ok_or(Error::Limit)?;
                self.folders.insert(
                    path.into(),
                    Folder {
                        counts: None,
                        validity: self.validity,
                        next: 1,
                        highest: self.seq,
                        entries: vec![],
                        subscribed: false,
                        role: None,
                    },
                );
            }
            FolderOp::Subscribe(value) => {
                self.folders.get_mut(path).ok_or(Error::Missing)?.subscribed = value
            }
            action => {
                let f = self.folder(path)?;
                if f.role.is_some() || path == "INBOX" {
                    return Err(Error::Cannot);
                }
                if let FolderOp::Rename(to) = action {
                    if !valid(to) {
                        return Err(Error::Cannot);
                    }
                    if self.folders.contains_key(to) {
                        return Err(Error::Exists);
                    }
                    let f = self.folders.remove(path).ok_or(Error::Missing)?;
                    self.folders.insert(to.into(), f);
                    if let Some(g) = self.gone.remove(path) {
                        self.gone.insert(to.into(), g);
                    }
                } else {
                    self.folders.remove(path);
                    self.gone.remove(path);
                }
            }
        }
        Ok(())
    }
    /// The fixture's own bound on what it keeps (Change::Append).
    fn quota(&self) -> Result<Option<Quota>, Error> {
        let entries = || self.folders.values().flat_map(|f| &f.entries);
        Ok(Some(Quota {
            bytes: entries().map(|e| e.raw.len() as u64).sum(),
            messages: entries().count() as u64,
            max_bytes: Some(MEMORY_BYTES as u64),
            max_messages: None,
        }))
    }
    fn vanished(&self, path: &str, since: u64) -> Result<Option<Vec<u32>>, Error> {
        self.folder(path)?;
        let Some((floor, list)) = self.gone.get(path) else {
            return Ok(Some(vec![]));
        };
        Ok((since >= *floor).then(|| list.iter().filter(|g| g.1 > since).map(|g| g.0).collect()))
    }
    fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
        let f = self.folder(path)?;
        let mut result = Applied {
            validity: f.validity,
            pairs: vec![],
            modified: vec![],
        };
        self.seq += 1;
        let seq = self.seq;
        match change {
            Change::Append {
                raw,
                date,
                flags,
                source,
            } => {
                let message_id = (path == "Sent")
                    .then(|| {
                        mail_parser::MessageParser::default()
                            .parse_headers(raw)
                            .and_then(|m| {
                                m.message_id().filter(|s| s.len() <= 998).map(str::to_owned)
                            })
                    })
                    .flatten();
                let now = match source {
                    Origin::Client { now } => now,
                    Origin::Submission => date,
                };
                self.submitted.retain(|_, (t, _)| {
                    now.signed_duration_since(*t) < chrono::Duration::hours(24)
                });
                if matches!(source, Origin::Client { .. })
                    && let Some((_, uid)) =
                        message_id.as_ref().and_then(|id| self.submitted.get(id))
                    && self
                        .folder(path)?
                        .entries
                        .binary_search_by_key(uid, |e| e.uid)
                        .is_ok()
                {
                    result.pairs.push((0, *uid));
                    return Ok(result);
                }
                // Bound the demo adapter too; the real APPEND route enforces the inbox quota.
                if self
                    .folders
                    .values()
                    .flat_map(|f| &f.entries)
                    .map(|e| e.raw.len())
                    .sum::<usize>()
                    + raw.len()
                    > MEMORY_BYTES
                {
                    return Err(Error::Limit);
                }
                let f = self.folders.get_mut(path).ok_or(Error::Missing)?;
                if f.entries.len() >= 5000 {
                    return Err(Error::Limit);
                }
                let uid = f.next;
                f.next = f.next.checked_add(1).ok_or(Error::Limit)?;
                f.entries.push(Entry {
                    size: raw.len(),
                    uid,
                    id: seq,
                    raw: raw.into(),
                    date,
                    flags,
                    modseq: seq,
                });
                f.highest = seq;
                result.pairs.push((0, uid));
                if matches!(source, Origin::Submission)
                    && let Some(id) = message_id
                {
                    self.submitted.insert(id, (now, uid));
                }
            }
            Change::Flags(uids, mode, flags, unchanged_since) => {
                let held = &self.folder(path)?.entries;
                let (uids, modified): (Vec<u32>, Vec<u32>) = uids.iter().partition(|u| {
                    held.iter()
                        .find(|e| e.uid == **u)
                        .is_none_or(|e| unchanged_since.is_none_or(|n| e.modseq <= n))
                });
                result.modified = modified;
                let ids: BTreeSet<_> = self
                    .folder(path)?
                    .entries
                    .iter()
                    .filter(|e| uids.contains(&e.uid))
                    .map(|e| e.id)
                    .collect();
                for (name, f) in &mut self.folders {
                    for e in &mut f.entries {
                        if !ids.contains(&e.id) {
                            continue;
                        }
                        let local = name == path && uids.contains(&e.uid);
                        let deleted = e.flags.contains("\\Deleted");
                        match mode {
                            Mode::Add => e.flags.extend(flags.iter().cloned()),
                            Mode::Remove => e.flags.retain(|s| !flags.contains(s)),
                            Mode::Replace => e.flags = flags.clone(),
                        }
                        if !local {
                            e.flags.remove("\\Deleted");
                            if deleted {
                                e.flags.insert("\\Deleted".into());
                            }
                        }
                        e.modseq = seq;
                        f.highest = seq;
                    }
                }
            }
            Change::Expunge(uids) => {
                let f = self.folders.get_mut(path).ok_or(Error::Missing)?;
                let mut removed = vec![];
                f.entries.retain(|e| {
                    let expunge = e.flags.contains("\\Deleted")
                        && uids.is_none_or(|list| list.contains(&e.uid));
                    if expunge {
                        removed.push(e.uid)
                    }
                    !expunge
                });
                f.highest = seq;
                self.bury(path, removed, seq);
            }
            Change::Transfer(uids, to, moving) => {
                let mut copies: Vec<_> = self
                    .folder(path)?
                    .entries
                    .iter()
                    .filter(|e| uids.contains(&e.uid))
                    .cloned()
                    .collect();
                let dst = self.folders.get_mut(to).ok_or(Error::Missing)?;
                if dst.entries.len() + copies.len() > 5000
                    || dst.next.checked_add(copies.len() as u32).is_none()
                {
                    return Err(Error::Limit);
                }
                result.validity = dst.validity;
                for e in &mut copies {
                    result.pairs.push((e.uid, dst.next));
                    e.uid = dst.next;
                    dst.next += 1;
                    e.modseq = seq;
                }
                dst.entries.extend(copies);
                dst.highest = seq;
                if moving {
                    let src = self.folders.get_mut(path).ok_or(Error::Missing)?;
                    src.entries.retain(|e| !uids.contains(&e.uid));
                    src.highest = seq;
                    let moved: Vec<_> = result.pairs.iter().map(|p| p.0).collect();
                    self.bury(path, moved, seq);
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn append(m: &mut Memory, p: &str, raw: &[u8]) -> u32 {
        let now = Date::default();
        m.change(
            p,
            Change::Append {
                raw,
                date: now,
                source: Origin::Client { now },
                flags: Flags::new(),
            },
        )
        .unwrap()
        .pairs[0]
            .1
    }
    #[test]
    fn shared_read_state_but_per_entry_deleted_and_monotone_folder_uids() {
        let mut m = Memory::default();
        let x = append(&mut m, "INBOX", b"sample");
        let copied = m
            .change("INBOX", Change::Transfer(&[x], "Drafts", false))
            .unwrap()
            .pairs[0]
            .1;
        m.change(
            "Drafts",
            Change::Flags(
                &[copied],
                Mode::Add,
                Flags::from(["\\Seen".into(), "\\Deleted".into()]),
                None,
            ),
        )
        .unwrap();
        let source = &m.folder("INBOX").unwrap().entries[0];
        assert!(source.flags.contains("\\Seen"));
        assert!(!source.flags.contains("\\Deleted"));
        assert_eq!(source.modseq, m.folder("Drafts").unwrap().entries[0].modseq);
        m.change("Drafts", Change::Expunge(None)).unwrap();
        assert!(m.folder("Drafts").unwrap().entries.is_empty());
        let next = m
            .change("INBOX", Change::Transfer(&[x], "Drafts", true))
            .unwrap()
            .pairs[0]
            .1;
        assert!(next > copied);
        assert!(m.folder("INBOX").unwrap().entries.is_empty());
        assert_eq!(
            m.folder("Drafts").unwrap().entries[0].raw.as_ref(),
            b"sample"
        );
    }
    #[test]
    fn failed_move_does_not_remove_source() {
        let mut m = Memory::default();
        let x = append(&mut m, "INBOX", b"fixture");
        assert!(
            m.change("INBOX", Change::Transfer(&[x], "Missing", true))
                .is_err()
        );
        assert_eq!(m.folder("INBOX").unwrap().entries[0].uid, x);
    }
}

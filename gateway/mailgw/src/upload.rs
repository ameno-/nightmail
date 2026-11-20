use crate::admission::Reservation;
use anyhow::Result;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

/// Disk spool is anonymous (unlinked), bounded and owned by the connection. Allows
/// signing the digest before sending headers, without retaining the literal in RAM.
pub struct Upload {
    file: tokio::fs::File,
    hash: Sha256,
    pub remaining: usize,
    pub size: usize,
    _reservation: Reservation,
}
impl Upload {
    pub fn new(size: usize, reservation: Reservation) -> Result<Self> {
        Ok(Self {
            file: tokio::fs::File::from_std(tempfile::tempfile()?),
            hash: Sha256::new(),
            size,
            remaining: size,
            _reservation: reservation,
        })
    }
    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        anyhow::ensure!(data.len() <= self.remaining, "append exceeds reservation");
        self.file.write_all(data).await?;
        self.hash.update(data);
        self.remaining -= data.len();
        Ok(())
    }
    pub async fn finish(&mut self) -> Result<(reqwest::Body, String)> {
        anyhow::ensure!(self.remaining == 0, "incomplete append");
        self.file.rewind().await?;
        Ok((
            reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(
                self.file.try_clone().await?,
            )),
            hex::encode(self.hash.clone().finalize()),
        ))
    }
}

/// SMTP DATA, whose length isn't known up front, on disk while it arrives: an anonymous file, its SHA-256 and size.
/// The connection owns it; dropping it removes the file.
pub struct Spool {
    file: std::io::BufWriter<std::fs::File>,
    hash: Sha256,
    pub size: usize,
}
impl Spool {
    pub fn new() -> Result<Self> {
        Ok(Self {
            file: std::io::BufWriter::with_capacity(64 << 10, tempfile::tempfile()?),
            hash: Sha256::new(),
            size: 0,
        })
    }
    pub fn write(&mut self, data: &[u8]) -> bool {
        use std::io::Write;
        if self.file.write_all(data).is_err() {
            return false;
        }
        self.hash.update(data);
        self.size += data.len();
        true
    }
    /// The message as a request body, its SHA-256 and its size.
    pub fn finish(self) -> Result<(reqwest::Body, String, usize)> {
        use std::io::Seek;
        let mut file = self.file.into_inner().map_err(|e| e.into_error())?;
        file.rewind()?;
        Ok((
            reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(
                tokio::fs::File::from_std(file),
            )),
            hex::encode(self.hash.finalize()),
            self.size,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn an_upload_owns_capacity_until_complete_or_dropped() {
        let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(2));
        let mut upload =
            Upload::new(2, Reservation::take(slots.clone(), None, 2).await.unwrap()).unwrap();
        assert_eq!(slots.available_permits(), 0);
        assert!(upload.finish().await.is_err());
        assert!(upload.write(b"abc").await.is_err());
        upload.write(b"a").await.unwrap();
        upload.write(b"b").await.unwrap();
        assert_eq!(
            upload.finish().await.unwrap().1,
            hex::encode(Sha256::digest(b"ab"))
        );
        drop(upload);
        assert_eq!(slots.available_permits(), 2);
    }
}

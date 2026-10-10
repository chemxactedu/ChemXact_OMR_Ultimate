import React, { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, WidthType } from 'docx';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { auth, loginWithGoogle, logoutUser } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV ? 'http://localhost:8001' : 'https://chemxact-omr-api.onrender.com')
).trim().replace(/[/.]+$/, '');
const MAX_SCAN_FILES = 4;
const USAGE_FETCH_RETRY_DELAYS = [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000];
const RETRYABLE_API_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function fetchUsageWithRetry(url, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!RETRYABLE_API_STATUSES.has(response.status) || attempt >= USAGE_FETCH_RETRY_DELAYS.length) {
        return response;
      }
      await new Promise((resolve) => window.setTimeout(resolve, USAGE_FETCH_RETRY_DELAYS[attempt]));
    } catch (requestError) {
      if (!(requestError instanceof TypeError) || attempt >= USAGE_FETCH_RETRY_DELAYS.length) {
        throw requestError;
      }
      await new Promise((resolve) => window.setTimeout(resolve, USAGE_FETCH_RETRY_DELAYS[attempt]));
    }
  }
}

async function readApiResponse(response, unavailableMessage) {
  try {
    return await response.json();
  } catch {
    if (!response.ok) {
      throw new Error(response.status >= 500 ? unavailableMessage : 'The scan service returned an invalid response.');
    }
    throw new Error('The scan service returned an unreadable response. Please try again.');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function resultRows(results) {
  return results.map((result, index) => ({
    'Scan #': index + 1,
    'Student Name': result.student_name || '',
    'Roll / Role': result.roll || '',
    Score: result.score ?? '',
    Questions: result.total ?? 40,
    'Full Marks': result.full_mark ?? result.total ?? 40,
    Status: result.status,
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function createResultId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createScanAudioContext() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return null;
  try {
    const audioContext = new AudioContextConstructor();
    audioContext.resume().catch((audioError) => {
      console.warn('Could not activate the scan-complete sound.', audioError);
    });
    return audioContext;
  } catch (audioError) {
    console.warn('Could not prepare the scan-complete sound.', audioError);
    return null;
  }
}

function playScanCompleteSound(audioContext) {
  if (!audioContext) return;
  try {
    const startAt = audioContext.currentTime;
    [659.25, 880].forEach((frequency, index) => {
      const start = startAt + index * 0.13;
      const oscillator = audioContext.createOscillator();
      const volume = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, start);
      volume.gain.exponentialRampToValueAtTime(0.12, start + 0.025);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);
      oscillator.connect(volume);
      volume.connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.2);
    });
    window.setTimeout(() => {
      audioContext.close().catch((audioError) => {
        console.warn('Could not close the scan-complete sound.', audioError);
      });
    }, 500);
  } catch (audioError) {
    console.warn('Could not play the scan-complete sound.', audioError);
    audioContext.close().catch((closeError) => {
      console.warn('Could not close the scan-complete sound.', closeError);
    });
  }
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const loginInProgress = useRef(false);
  const [answerKey, setAnswerKey] = useState('');
  const [fullMarks, setFullMarks] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [resultsOwnerUid, setResultsOwnerUid] = useState(null);
  const [expandedResultIndex, setExpandedResultIndex] = useState(null);
  const [editingResultId, setEditingResultId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [publicStats, setPublicStats] = useState(null);
  const [publicStatsError, setPublicStatsError] = useState('');
  const [publicStatsLoading, setPublicStatsLoading] = useState(true);
  const [publicStatsRefresh, setPublicStatsRefresh] = useState(0);
  const [savedAnswerKeys, setSavedAnswerKeys] = useState([]);
  const [answerKeyName, setAnswerKeyName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [usageRefresh, setUsageRefresh] = useState(0);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoadingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!loadingAuth && !user && window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }
  }, [loadingAuth, user]);

  useEffect(() => {
    let cancelled = false;
    const loadPublicStats = async () => {
      setPublicStatsLoading(true);
      setPublicStatsError('');
      try {
        const response = await fetchUsageWithRetry(`${API_BASE_URL}/api/public-stats`);
        const data = await readApiResponse(response, 'Usage statistics are temporarily unavailable.');
        if (!response.ok) throw new Error(data.detail || 'Usage statistics are temporarily unavailable.');
        if (!cancelled) setPublicStats(data);
      } catch (statsError) {
        if (!cancelled) setPublicStatsError(statsError.message || 'Usage statistics are temporarily unavailable.');
      } finally {
        if (!cancelled) setPublicStatsLoading(false);
      }
    };
    loadPublicStats();
    return () => { cancelled = true; };
  }, [publicStatsRefresh]);

  useEffect(() => {
    if (!user) {
      setSavedAnswerKeys([]);
      return;
    }

    try {
      const storedKeys = JSON.parse(window.localStorage.getItem(`ousi-answer-keys-${user.uid}`) || '[]');
      if (!Array.isArray(storedKeys)) throw new Error('Saved answer keys must be a list.');
      setSavedAnswerKeys(storedKeys.filter((key) => (
        key
        && typeof key.id === 'string'
        && typeof key.name === 'string'
        && typeof key.answers === 'string'
        && /^[A-D]+$/.test(key.answers)
      )));
    } catch (storageError) {
      setSavedAnswerKeys([]);
      setError(`Could not load saved answer keys: ${storageError.message}`);
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setResults([]);
      setResultsOwnerUid(null);
      return;
    }

    try {
      const storedResults = JSON.parse(window.localStorage.getItem(`ousi-scan-results-${user.uid}`) || '[]');
      if (!Array.isArray(storedResults)) throw new Error('Saved scan results must be a list.');
      setResults(storedResults.filter((result) => (
        result
        && typeof result.id === 'string'
        && ['Scanned', 'Failed', 'Not scanned'].includes(result.status)
      )));
    } catch (storageError) {
      setResults([]);
      setError(`Could not load saved scan results: ${storageError.message}`);
    }
    setResultsOwnerUid(user.uid);
  }, [user]);

  useEffect(() => {
    if (!user || resultsOwnerUid !== user.uid) return;
    try {
      window.localStorage.setItem(`ousi-scan-results-${user.uid}`, JSON.stringify(results));
    } catch (storageError) {
      setError(`Could not save scan results on this device: ${storageError.message}`);
    }
  }, [results, resultsOwnerUid, user]);

  useEffect(() => {
    if (!user) {
      setUsage(null);
      setUsageLoading(false);
      setUsageError('');
      return undefined;
    }

    let cancelled = false;
    const loadUsage = async () => {
      setUsageLoading(true);
      setUsageError('');
      setError('');
      if (!API_BASE_URL) {
        if (!cancelled) {
          const message = 'Scan API is not configured. Set VITE_API_BASE_URL before building the deployed frontend.';
          setUsageError(message);
          setError(message);
          setUsageLoading(false);
        }
        return;
      }
      try {
        const token = await user.getIdToken();
        const response = await fetchUsageWithRetry(`${API_BASE_URL}/api/usage`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readApiResponse(response, 'The scan service is waking up or temporarily busy. Please retry in a moment.');
        if (!response.ok) throw new Error(data.detail || 'Could not load scan quota.');
        if (!cancelled) setUsage(data);
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof TypeError && loadError.message === 'Failed to fetch'
            ? 'Could not reach the scan service after several tries. Check VITE_API_BASE_URL and make sure Render CORS_ORIGINS includes this website domain.'
            : loadError.message || 'Could not load scan quota.';
          setUsageError(message);
          setError(message);
        }
      } finally {
        if (!cancelled) setUsageLoading(false);
      }
    };
    loadUsage();
    return () => { cancelled = true; };
  }, [user, usageRefresh]);

  const handleLogin = async () => {
    if (loginInProgress.current) return;
    loginInProgress.current = true;
    setIsLoggingIn(true);
    try {
      await loginWithGoogle();
    } catch (loginError) {
      const message = loginError.code === 'auth/popup-blocked'
        ? 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.'
        : loginError.code === 'auth/cancelled-popup-request'
          ? 'Another Google sign-in window replaced this request. Close any open sign-in window, then try again once.'
        : loginError.code === 'auth/popup-closed-by-user'
          ? 'The Google sign-in window was closed before login finished. Please try again.'
          : loginError.code === 'auth/network-request-failed'
            ? 'Google sign-in could not reach Firebase. Check your connection, VPN, or ad blocker and try again.'
            : loginError.code === 'auth/unauthorized-domain'
              ? 'This website address is not authorized for Google sign-in. Add its domain to Firebase Authentication’s authorized domains.'
              : loginError.code === 'auth/operation-not-allowed'
                ? 'Google sign-in is not enabled for this Firebase project. Enable the Google provider in Firebase Authentication.'
            : `Login failed: ${loginError.message}`;
      setError(message);
    } finally {
      loginInProgress.current = false;
      setIsLoggingIn(false);
    }
  };

  const saveAnswerKey = () => {
    const answers = answerKey.trim().toUpperCase();
    if (!/^[A-D]+$/.test(answers)) {
      setError('Enter at least one answer using A, B, C, or D before saving.');
      return;
    }
    const name = answerKeyName.trim();
    if (!name) {
      setError('Add a name for this answer key before saving.');
      return;
    }

    const savedKey = {
      id: createResultId(),
      name,
      answers,
      fullMarks: fullMarks.trim(),
    };
    const updatedKeys = [...savedAnswerKeys, savedKey];
    try {
      window.localStorage.setItem(`ousi-answer-keys-${user.uid}`, JSON.stringify(updatedKeys));
      setSavedAnswerKeys(updatedKeys);
      setAnswerKeyName('');
      setError('');
      setNotice(`“${name}” answer key saved on this device.`);
    } catch (storageError) {
      setError(`Could not save this answer key in your browser: ${storageError.message}`);
    }
  };

  const applyAnswerKey = (savedKey) => {
    setAnswerKey(savedKey.answers);
    setFullMarks(savedKey.fullMarks || '');
    setError('');
    setNotice(`“${savedKey.name}” answer key loaded.`);
  };

  const deleteAnswerKey = (savedKey) => {
    const updatedKeys = savedAnswerKeys.filter((key) => key.id !== savedKey.id);
    try {
      window.localStorage.setItem(`ousi-answer-keys-${user.uid}`, JSON.stringify(updatedKeys));
      setSavedAnswerKeys(updatedKeys);
      setError('');
      setNotice(`“${savedKey.name}” answer key deleted from this device.`);
    } catch (storageError) {
      setError(`Could not delete this saved answer key: ${storageError.message}`);
    }
  };

  const handleSelectFiles = (event) => {
    const files = Array.from(event.target.files || []);
    const availableSlots = Math.max(0, MAX_SCAN_FILES - selectedFiles.length);
    const acceptedFiles = files.slice(0, availableSlots);
    setSelectedFiles([...selectedFiles, ...acceptedFiles]);
    setError(files.length > availableSlots
      ? `You can upload up to ${MAX_SCAN_FILES} sheets per scan. Only the first ${availableSlots} selected file${availableSlots === 1 ? '' : 's'} were added.`
      : '');
    setNotice('');
    event.target.value = '';
  };

  const handleScan = async () => {
    if (!selectedFiles.length) {
      setError('Select at least one OMR sheet image.');
      return;
    }
    if (selectedFiles.length > MAX_SCAN_FILES) {
      setError(`You can scan up to ${MAX_SCAN_FILES} sheets at a time. Remove extra sheets and try again.`);
      return;
    }
    if (!API_BASE_URL) {
      setError('Scan API is not configured. Set VITE_API_BASE_URL before building the deployed frontend.');
      return;
    }
    const normalizedKey = answerKey.trim().toUpperCase();
    if (!/^[A-D]+$/.test(normalizedKey)) {
      setError('Enter at least one answer using A, B, C, or D.');
      return;
    }
    const fullMarkValue = fullMarks.trim() ? Number(fullMarks) : normalizedKey.length;
    if (!Number.isFinite(fullMarkValue) || fullMarkValue <= 0) {
      setError('Full marks must be a number greater than zero.');
      return;
    }

    let completionAudio = createScanAudioContext();
    setIsScanning(true);
    setError('');
    setNotice('');
    try {
      const healthResponse = await fetchUsageWithRetry(`${API_BASE_URL}/health`);
      const health = await readApiResponse(healthResponse, 'The scan service is waking up or temporarily busy. Please retry in a moment.');
      if (!healthResponse.ok || health.status !== 'ok') {
        throw new Error(health.detail || 'The scan service is not ready. Please try again shortly.');
      }

      const token = await user.getIdToken();
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      formData.append('answer_key', normalizedKey);

      const response = await fetch(`${API_BASE_URL}/api/bulk-scan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await readApiResponse(response, 'The scan service is temporarily busy. Your selected sheets are still here; please retry.');
      if (!response.ok) throw new Error(data.detail || 'Scan request failed.');
      if (!Array.isArray(data.results)) {
        throw new Error('The scan service returned an invalid result list. Your selected sheets are still here; please retry.');
      }

      setResults((current) => [
        ...current,
        ...data.results.map((result) => ({
          ...result,
          full_mark: fullMarkValue,
          id: createResultId(),
          scannedAt: new Date().toISOString(),
        })),
      ]);
      const retryableFileIndexes = data.results
        .flatMap((result, index) => (result.status === 'Scanned' ? [] : [index]));
      setSelectedFiles(retryableFileIndexes
        .map((index) => selectedFiles[index])
        .filter(Boolean));
      if (data.usage) {
        setUsage(data.usage);
        setUsageError('');
      } else if (data.usage_error) {
        setUsageError(data.usage_error);
      }
      const completed = data.results.filter((result) => result.status === 'Scanned').length;
      const failed = data.results.filter((result) => result.status === 'Failed').length;
      if (completed > 0) {
        playScanCompleteSound(completionAudio);
        completionAudio = null;
      } else if (completionAudio) {
        completionAudio.close().catch((audioError) => {
          console.warn('Could not close the scan-complete sound.', audioError);
        });
        completionAudio = null;
      }
      setNotice(
        `${completed} sheet${completed === 1 ? '' : 's'} scanned` +
        `${failed ? `; ${failed} failed` : ''}.` +
        (failed ? ' Failed sheets remain selected so you can retry.' : '') +
        (data.quota_reached ? ' Daily limit reached; unscanned images are still selected for tomorrow.' : '') +
        (data.quota_error ? ` ${data.quota_error}` : '') +
        (data.usage_error ? ` ${data.usage_error}` : ''),
      );
    } catch (scanError) {
      setError(scanError instanceof TypeError && scanError.message === 'Failed to fetch'
        ? 'Could not reach the scan service. Check VITE_API_BASE_URL and make sure Render CORS_ORIGINS includes this website domain.'
        : scanError.message || 'Could not connect to the scan server.');
    } finally {
      if (completionAudio) {
        completionAudio.close().catch((audioError) => {
          console.warn('Could not close the scan-complete sound.', audioError);
        });
      }
      setIsScanning(false);
    }
  };

  const startEditingResult = (result) => {
    setEditingResultId(result.id);
    setEditDraft({
      student_name: result.student_name || '',
      roll: result.roll === 'Unknown' ? '' : (result.roll || ''),
      score: result.score == null ? '' : String(result.score),
    });
    setError('');
  };

  const cancelEditingResult = () => {
    setEditingResultId(null);
    setEditDraft(null);
  };

  const saveEditedResult = (result) => {
    const studentName = editDraft?.student_name.trim();
    const roll = editDraft?.roll.trim() || 'Unknown';
    const score = Number(editDraft?.score);
    const total = result.total || 40;

    if (!studentName) {
      setError('Student name cannot be empty.');
      return;
    }
    if (!Number.isInteger(score) || score < 0 || score > total) {
      setError(`Score must be a whole number between 0 and ${total}.`);
      return;
    }

    setResults((current) => current.map((entry) => (
      entry.id === result.id
        ? {
          ...entry,
          student_name: studentName,
          roll,
          score,
          scoreEdited: entry.scoreEdited || score !== entry.score,
        }
        : entry
    )));
    cancelEditingResult();
  };

  const deleteResult = (result) => {
    const studentName = result.student_name || result.filename || 'this student';
    if (!window.confirm(`Remove ${studentName} from this results list?`)) return;
    setResults((current) => current.filter((entry) => entry.id !== result.id));
    if (expandedResultIndex === result.id) setExpandedResultIndex(null);
    if (editingResultId === result.id) cancelEditingResult();
  };

  const exportExcel = () => {
    const workbook = XLSX.utils.book_new();
    const scores = XLSX.utils.json_to_sheet(resultRows(results));
    XLSX.utils.book_append_sheet(workbook, scores, 'Student Results');
    XLSX.writeFile(workbook, 'omr-student-results.xlsx');
  };

  const exportPdf = async () => {
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageRows = 15;
    for (let start = 0; start < results.length; start += pageRows) {
      const report = document.createElement('div');
      report.style.cssText = 'position:fixed;left:-12000px;top:0;width:1120px;padding:32px;background:#fff;color:#111827;font:20px Arial,sans-serif';
      const rows = results.slice(start, start + pageRows).map((result, offset) => `
        <tr>
          <td>${start + offset + 1}</td>
          <td>${escapeHtml(result.student_name || '-')}</td>
          <td>${escapeHtml(result.roll || '-')}</td>
          <td>${result.score == null ? '-' : `${result.score}/${result.total || 40}`}</td>
          <td>${result.full_mark ?? result.total ?? 40}</td>
          <td>${escapeHtml(result.status || '-')}</td>
        </tr>
      `).join('');
      report.innerHTML = `
        <h1 style="font-size:30px;margin:0 0 24px">OMR Student Results</h1>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#dbeafe">
            <th style="text-align:left">#</th><th style="text-align:left">Student Name</th>
            <th style="text-align:left">Roll / Role</th><th style="text-align:left">Correct</th>
            <th style="text-align:left">Full Marks</th>
            <th style="text-align:left">Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
      report.querySelectorAll('th, td').forEach((cell) => {
        cell.style.cssText = 'border:1px solid #cbd5e1;padding:10px 12px;text-align:left;vertical-align:top';
      });
      document.body.appendChild(report);
      try {
        const canvas = await html2canvas(report, { scale: 2, backgroundColor: '#ffffff' });
        const image = canvas.toDataURL('image/png');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const scale = Math.min((pageWidth - 20) / canvas.width, (pageHeight - 20) / canvas.height);
        const imageWidth = canvas.width * scale;
        const imageHeight = canvas.height * scale;
        if (start > 0) pdf.addPage();
        pdf.addImage(image, 'PNG', (pageWidth - imageWidth) / 2, 10, imageWidth, imageHeight);
      } finally {
        report.remove();
      }
    }
    pdf.save('omr-student-results.pdf');
  };

  const exportDocx = async () => {
    const rows = [
      ['#', 'Student Name', 'Roll / Role', 'Correct', 'Full Marks', 'Status'],
      ...results.map((result, index) => [
        String(index + 1),
        result.student_name || '-',
        result.roll || '-',
        result.score == null ? '-' : `${result.score}/${result.total || 40}`,
        String(result.full_mark ?? result.total ?? 40),
        result.status || '-',
      ]),
    ];
    const table = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map((row) => new TableRow({
        children: row.map((text) => new TableCell({
          children: [new Paragraph(String(text))],
        })),
      })),
    });
    const document = new Document({
      sections: [{
        children: [
          new Paragraph({ text: 'OMR Student Results', heading: 'Heading1' }),
          table,
        ],
      }],
    });
    downloadBlob(await Packer.toBlob(document), 'omr-student-results.docx');
  };

  const runExport = async (exporter) => {
    try {
      setError('');
      await exporter();
    } catch (exportError) {
      setError(`Export failed: ${exportError.message}`);
    }
  };

  const scannedResults = results.filter((result) => result.status === 'Scanned');
  const averageScore = scannedResults.length
    ? Math.round(scannedResults.reduce((sum, result) => sum + ((result.score || 0) / (result.total || 40) * 100), 0) / scannedResults.length)
    : 0;

  if (loadingAuth) {
    return (
      <div className="app-loading">
        <div className="loading-mark">✦</div>
        <p>Getting your classroom ready…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-decoration login-decoration-one" />
        <div className="login-decoration login-decoration-two" />
        <main className="login-card">
          <div className="brand-lockup login-brand">
            <span className="brand-mark" aria-hidden="true"><span>✳</span></span>
            <span><strong>OMR <span className="brand-descriptor">- Easy Scanner</span></strong><small>POWERED BY CHEMXACT</small></span>
          </div>
          <div className="login-illustration" aria-hidden="true">
            <span className="illustration-spark spark-one">✦</span>
            <span className="illustration-spark spark-two">✧</span>
            <div className="illustration-sheet">
              <span /><span /><span />
              <i>✓</i>
            </div>
            <div className="illustration-pencil">✎</div>
          </div>
          <span className="eyebrow">Free online OMR scanner for teachers</span>
          <h1>Make room for<br /><em>more teaching.</em></h1>
          <p className="login-copy">Scan answer sheets, spot learning wins, and get back to the moments that matter in your classroom.</p>
          {error && <p role="alert" className="alert alert-error">{error}</p>}
          <button onClick={handleLogin} className="button button-primary login-button" disabled={isLoggingIn}>
            <span className="google-mark" aria-hidden="true">G</span>
            {isLoggingIn ? 'Opening Google sign-in…' : 'Continue with Google'}
            {!isLoggingIn && <span aria-hidden="true">→</span>}
          </button>
          {publicStats && (
            <div className="login-usage-stats" aria-label="Ousi usage statistics">
              <span><strong>{Number(publicStats.teachers).toLocaleString()}</strong> teachers</span>
              <i aria-hidden="true">·</i>
              <span><strong>{Number(publicStats.scanned_sheets).toLocaleString()}</strong> OMR sheets scanned</span>
            </div>
          )}
          {publicStatsLoading && <p className="login-stats-status" role="status">Loading usage statistics…</p>}
          {publicStatsError && (
            <p className="login-stats-status" role="status">
              Usage statistics unavailable.{' '}
              <button type="button" onClick={() => setPublicStatsRefresh((version) => version + 1)}>
                Retry
              </button>
            </p>
          )}
          <p className="login-footnote"><span>✦</span> Made for curious classrooms</p>
        </main>
      </div>
    );
  }

  const quotaReached = usage && !usage.is_premium && usage.remaining === 0;
  const isFaqPage = window.location.pathname.replace(/\/+$/, '') === '/free-omr-scanner';

  if (isFaqPage) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <a className="brand-lockup faq-brand" href="/" aria-label="Return to OMR scanner">
            <span className="brand-mark" aria-hidden="true"><span>✳</span></span>
            <span><strong>OMR <span className="brand-descriptor">- Easy Scanner</span></strong><small>POWERED BY CHEMXACT</small></span>
          </a>
          <div className="teacher-profile">
            {user.photoURL
              ? <img src={user.photoURL} alt="" className="teacher-avatar" />
              : <span className="teacher-avatar avatar-fallback">{(user.displayName || user.email || 'T').charAt(0).toUpperCase()}</span>}
            <span className="teacher-name">{user.displayName?.split(' ')[0] || 'Teacher'}</span>
            <button onClick={logoutUser} className="logout-button">Sign out</button>
          </div>
        </header>
        <main className="faq-page">
          <a className="faq-back-link" href="/">← Back to scanner</a>
          <section className="faq-hero">
            <span className="eyebrow">OMR SCANNER HELP</span>
            <h1>How Ousi’s OMR scanner works</h1>
            <p>Use the scanner to check student answer sheets, review each result, and export your class scores.</p>
          </section>
          <section className="faq-content" aria-labelledby="faq-how-title">
            <h2 id="faq-how-title">How to scan an OMR sheet</h2>
            <ol>
              <li>Enter the correct answers using A, B, C, or D. The number of answers sets the question count.</li>
              <li>Choose up to four clear, full-page OMR sheet images. Each image must be 10 MB or smaller.</li>
              <li>Press Scan and wait while Ousi reads the marks. Review the student name, roll, answers, and score.</li>
              <li>Edit details if needed, then export the class results as Excel, PDF, or Word.</li>
            </ol>
          </section>
          <section className="faq-content" aria-labelledby="faq-questions-title">
            <h2 id="faq-questions-title">Frequently asked questions</h2>
            <div className="faq-list">
              <article className="faq-item">
                <h3>Can I use the OMR scanner on my phone?</h3>
                <p>Yes. Use a modern mobile or desktop browser. Select clear sheet photos from your device.</p>
              </article>
              <article className="faq-item">
                <h3>How many sheets can I scan at once?</h3>
                <p>You can upload up to four sheets per scan. The free daily scan allowance is shown in your account.</p>
              </article>
              <article className="faq-item">
                <h3>What happens if a scan fails?</h3>
                <p>Ousi retries temporary model errors and can switch to another configured vision model. A failed sheet remains available to retry; if the service is temporarily unavailable, try again shortly.</p>
              </article>
              <article className="faq-item">
                <h3>Are scanned results saved?</h3>
                <p>Results are saved in this browser on this device for your account until you delete them. They do not sync to another phone or computer.</p>
              </article>
              <article className="faq-item">
                <h3>Can I export or delete results?</h3>
                <p>Yes. Export the results list as Excel, PDF, or Word. Delete a single result or clear the whole list whenever you choose.</p>
              </article>
              <article className="faq-item">
                <h3>Are OMR scan results always correct?</h3>
                <p>No automated scanner is perfect. Use a clear, well-lit, full-sheet image and check unclear answers against the original sheet before finalizing marks.</p>
              </article>
            </div>
          </section>
          <a className="button button-primary faq-open-scanner" href="/">Open OMR scanner</a>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><span>✳</span></span>
          <span><strong>OMR <span className="brand-descriptor">- Easy Scanner</span></strong><small>POWERED BY CHEMXACT</small></span>
        </div>
        <div className="topbar-right">
          <div className="quota-pill">
            <span className="quota-spark">✦</span>
            <span>{usage?.is_premium ? 'Unlimited scans' : usage ? `${usage.remaining} scans left today` : usageLoading ? 'Checking scan limit…' : usageError ? 'Scan limit unavailable' : 'Scan limit not loaded'}</span>
            {usageError && (
              <button
                type="button"
                className="quota-retry"
                onClick={() => setUsageRefresh((version) => version + 1)}
                disabled={usageLoading}
              >
                {usageLoading ? 'Retrying…' : 'Retry'}
              </button>
            )}
          </div>
          <div className="teacher-profile">
            {user.photoURL
              ? <img src={user.photoURL} alt="" className="teacher-avatar" />
              : <span className="teacher-avatar avatar-fallback">{(user.displayName || user.email || 'T').charAt(0).toUpperCase()}</span>}
            <span className="teacher-name">{user.displayName?.split(' ')[0] || 'Teacher'}</span>
            <button onClick={logoutUser} className="logout-button">Sign out</button>
          </div>
        </div>
      </header>

      <main className="dashboard">
        <section className="welcome-banner">
          <div className="welcome-copy">
            <h1 className="welcome-announcement"><span className="ousi-wordmark">Ousi</span> is here to help.</h1>
            <p>I'm an artificial intelligence, here to reduce your office workload—so you can spend more time helping your students learn.</p>
          </div>
          <div className="banner-art" aria-hidden="true">
            <span className="art-star star-left">✦</span>
            <span className="art-star star-right">✧</span>
            <div className="art-sun" />
            <div className="art-card">
              <span className="art-card-line line-long" />
              <span className="art-card-line" />
              <span className="art-card-line line-short" />
              <span className="art-check">✓</span>
            </div>
            <span className="art-pencil">✎</span>
          </div>
          <div className="banner-note">Small steps<br />add up <span>↗</span></div>
        </section>

        <section className="stat-grid" aria-label="Classroom scan summary">
          <article className="stat-card stat-lilac">
            <span className="stat-icon">✳</span>
            <div><span className="stat-label">Sheets checked</span><strong>{scannedResults.length}</strong><small>saved on this device</small></div>
          </article>
          <article className="stat-card stat-mint">
            <span className="stat-icon">↗</span>
            <div><span className="stat-label">Class average</span><strong>{scannedResults.length ? `${averageScore}` : '—'}<small className="stat-total">{scannedResults.length ? '%' : ''}</small></strong><small>average score</small></div>
          </article>
          <article className="stat-card stat-peach">
            <span className="stat-icon">☼</span>
            <div><span className="stat-label">Today’s allowance</span><strong>{usage?.is_premium ? '∞' : usage ? usage.remaining : '—'}<small className="stat-total">{usage?.is_premium ? '' : usage ? `/${usage.daily_limit}` : ''}</small></strong><small>{usage?.is_premium ? 'premium access' : 'scans remaining'}</small></div>
          </article>
        </section>

        <div className="section-heading">
          <div><span className="eyebrow">READY WHEN YOU ARE</span><h2>Let’s scan some sheets</h2></div>
          <p>Two quick steps, then you’re all set.</p>
        </div>

        {error && <p role="alert" className="alert alert-error">{error}</p>}
        {notice && <p role="status" className="alert alert-success"><span>✓</span>{notice}</p>}

        <section className="scan-grid">
          <article className="workspace-card key-card">
            <div className="card-heading">
              <span className="step-badge step-purple">01</span>
              <div><span className="card-kicker">FIRST THINGS FIRST</span><h3>Set your answer key</h3></div>
              <span className="heading-doodle" aria-hidden="true">✎</span>
            </div>
            <p className="card-description">Enter all correct answers in one box, then add the exam’s full marks separately.</p>
            <label htmlFor="answer-key" className="field-label">ANSWER KEY <span>A–D only</span></label>
            <textarea
              id="answer-key"
              value={answerKey}
              onChange={(event) => setAnswerKey(event.target.value.toUpperCase().replace(/[^A-D]/g, ''))}
              rows={3}
              className="answer-input"
              aria-describedby="answer-key-count answer-key-help"
            />
            <label htmlFor="full-marks" className="field-label full-marks-label">FULL MARKS <span>Optional · defaults to number of questions</span></label>
            <input
              id="full-marks"
              type="number"
              min="0.01"
              step="any"
              value={fullMarks}
              onChange={(event) => setFullMarks(event.target.value)}
              placeholder={String(answerKey.length || 0)}
              className="full-marks-input"
              aria-describedby="full-marks-help"
            />
            <span id="full-marks-help" className="answer-key-help">This is shown separately; the score remains the number of correct answers.</span>
            <div className="field-footer">
              <span>
                <span id="answer-key-count" className={answerKey.length > 0 ? 'field-valid' : ''}>
                  {answerKey.length ? '✓' : '○'} {answerKey.length} {answerKey.length === 1 ? 'question' : 'questions'} · correct answers
                </span>
                <span id="answer-key-help" className="answer-key-help">Spaces, commas, and line breaks are ignored.</span>
              </span>
              <span>Questions 1–{answerKey.length || '—'}</span>
            </div>
            <div className="saved-keys">
              <label htmlFor="answer-key-name" className="field-label">SAVE THIS ANSWER KEY</label>
              <div className="save-key-controls">
                <input
                  id="answer-key-name"
                  type="text"
                  maxLength={60}
                  value={answerKeyName}
                  onChange={(event) => setAnswerKeyName(event.target.value)}
                  placeholder="e.g. Biology midterm"
                  aria-label="Name for saved answer key"
                />
                <button
                  type="button"
                  className="button button-secondary save-key-button"
                  onClick={saveAnswerKey}
                  disabled={!answerKey.trim() || !answerKeyName.trim()}
                >
                  Save key
                </button>
              </div>
              <p className="answer-key-help">Saved privately in this browser on this device.</p>
              {savedAnswerKeys.length > 0 && (
                <ul className="saved-key-list" aria-label="Saved answer keys">
                  {savedAnswerKeys.map((savedKey) => (
                    <li key={savedKey.id}>
                      <button
                        type="button"
                        className="saved-key-load"
                        onClick={() => applyAnswerKey(savedKey)}
                        aria-label={`Load ${savedKey.name}, ${savedKey.answers.length} questions`}
                      >
                        <strong>{savedKey.name}</strong>
                        <span>{savedKey.answers.length} questions{savedKey.fullMarks ? ` · ${savedKey.fullMarks} marks` : ''}</span>
                      </button>
                      <button
                        type="button"
                        className="saved-key-delete"
                        onClick={() => deleteAnswerKey(savedKey)}
                        aria-label={`Delete ${savedKey.name}`}
                        title={`Delete ${savedKey.name}`}
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>

          <article className="workspace-card upload-card" aria-busy={isScanning}>
            <div className="card-heading">
              <span className="step-badge step-mint">02</span>
              <div><span className="card-kicker">THEN, THE FUN PART</span><h3>Add student sheets</h3></div>
              <span className="heading-doodle upload-doodle" aria-hidden="true">↥</span>
            </div>
            <p className="card-description">Choose clear, full-page photos. Upload up to {MAX_SCAN_FILES} sheets per scan.</p>
            <label className="upload-zone">
              <input type="file" accept="image/*" multiple onChange={handleSelectFiles} />
              <span className="upload-icon" aria-hidden="true">↥</span>
              <span className="upload-title">{selectedFiles.length ? 'Add a few more sheets' : 'Drop your sheets here'}</span>
              <span className="upload-hint">or <strong>browse files</strong> · up to {MAX_SCAN_FILES} · JPG, PNG or WEBP</span>
            </label>
            {selectedFiles.length > 0 && (
              <div className="selected-files">
                <div className="selected-files-heading">
                  <span><i /> {selectedFiles.length} {selectedFiles.length === 1 ? 'sheet' : 'sheets'} ready to go</span>
                  <button type="button" onClick={() => setSelectedFiles([])}>Clear</button>
                </div>
                <ul className="file-list">
                  {selectedFiles.map((file, index) => (
                    <li key={`${file.name}-${index}`}><span className="file-type">IMG</span><span className="file-name">{file.name}</span><span className="file-check">✓</span></li>
                  ))}
                </ul>
              </div>
            )}
            <button
              onClick={handleScan}
              disabled={isScanning || !selectedFiles.length || quotaReached}
              className="button button-primary scan-button"
            >
              <span>{isScanning ? '✦' : '✳'}</span>
              {isScanning ? 'Ousi is scanning...' : quotaReached ? 'Daily scan limit reached' : `Scan ${selectedFiles.length || ''} ${selectedFiles.length === 1 ? 'sheet' : 'sheets'}`}
              {!isScanning && !quotaReached && <span className="button-arrow">→</span>}
            </button>
            {isScanning && (
              <div className="scan-progress" role="status" aria-live="polite">
                <span className="scan-progress-mark" aria-hidden="true"><i /></span>
                <span className="scan-progress-copy"><strong>Scanning your sheets</strong><small>Reading the marks now—this may take a moment.</small></span>
                <span className="scan-progress-track" aria-hidden="true"><i /></span>
              </div>
            )}
            {quotaReached && (
              <p className="quota-message">
                That’s all 15 scans for today. Come back tomorrow to keep going.
                <button onClick={() => setUsageRefresh((version) => version + 1)}>Refresh limit</button>
              </p>
            )}
          </article>
        </section>

        <section className="tip-strip">
          <span aria-hidden="true">☼</span>
          <p><strong>Teacher tip</strong> — Good lighting and a full-page photo help our scanner read every answer.</p>
          <span className="tip-decoration" aria-hidden="true">✦</span>
        </section>

        <section className="results-section">
          <div className="results-heading">
            <div>
              <span className="eyebrow">YOUR CLASS AT A GLANCE</span>
              <h2>Scan results <span className="result-count">{results.length}</span></h2>
              <p>Your results stay on this device for this account until you delete them; they do not sync to other devices.</p>
            </div>
            {results.length > 0 && (
              <div className="export-actions">
                <button onClick={() => runExport(exportExcel)} className="export-button export-excel"><span>↓</span> Excel</button>
                <button onClick={() => runExport(exportPdf)} className="export-button export-pdf"><span>↓</span> PDF</button>
                <button onClick={() => runExport(exportDocx)} className="export-button export-word"><span>↓</span> Word</button>
                <button onClick={() => { setResults([]); setExpandedResultIndex(null); cancelEditingResult(); }} className="clear-results">Clear list</button>
              </div>
            )}
          </div>
          {results.length > 0 ? (
            <div className="results-table-wrap">
              <table className="results-table">
                <thead>
                  <tr>{['#', 'Student', 'Roll / role', 'Correct', 'Full marks', 'Status', 'Actions'].map((heading) => <th key={heading}>{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {results.map((result, index) => {
                    const isExpanded = expandedResultIndex === result.id;
                    const isEditing = editingResultId === result.id;
                    const detailsId = `answer-details-${result.id}`;
                    return (
                      <React.Fragment key={result.id || `${result.filename}-${index}`}>
                        <tr className="result-row">
                          <td><span className="row-number">{String(index + 1).padStart(2, '0')}</span></td>
                          <td>
                            {isEditing ? (
                              <input
                                aria-label="Student name"
                                className="edit-input student-edit-input"
                                value={editDraft.student_name}
                                onChange={(event) => setEditDraft((draft) => ({ ...draft, student_name: event.target.value }))}
                                autoFocus
                              />
                            ) : <strong className="student-cell">{result.student_name || result.filename}</strong>}
                          </td>
                          <td>
                            {isEditing ? (
                              <input
                                aria-label="Student roll or role"
                                className="edit-input"
                                value={editDraft.roll}
                                onChange={(event) => setEditDraft((draft) => ({ ...draft, roll: event.target.value }))}
                              />
                            ) : <span className="roll-cell">{result.roll || '—'}</span>}
                          </td>
                          <td>
                            {isEditing ? (
                              <input
                                aria-label={`Student score out of ${result.total || 40}`}
                                className="edit-input score-edit-input"
                                type="number"
                                min="0"
                                max={result.total || 40}
                                step="1"
                                value={editDraft.score}
                                onChange={(event) => setEditDraft((draft) => ({ ...draft, score: event.target.value }))}
                              />
                            ) : (
                              <>
                                <span className={`score-chip ${result.score == null ? 'score-pending' : result.score / (result.total || 40) >= 0.75 ? 'score-good' : 'score-check'}`}>{result.score == null ? '—' : `${result.score}/${result.total || 40}`}</span>
                                {result.scoreEdited && <small className="edited-score-label">Teacher edited</small>}
                              </>
                            )}
                          </td>
                          <td><span className="full-mark-chip">{result.full_mark ?? result.total ?? 40}</span></td>
                          <td>
                            <span className={`status-pill ${result.status === 'Scanned' ? 'status-done' : 'status-waiting'}`}><i />{result.status}</span>
                            {result.message && <p className="result-message">{result.message}</p>}
                            {result.status === 'Scanned' && result.details?.length > 0 && (
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                aria-controls={detailsId}
                                onClick={() => setExpandedResultIndex(isExpanded ? null : result.id)}
                                className="details-toggle"
                              >
                                {isExpanded ? 'Hide teacher review ↑' : 'Teacher review ↓'}
                              </button>
                            )}
                          </td>
                          <td>
                            <div className="row-actions">
                              {isEditing ? (
                                <>
                                  <button type="button" className="row-action action-save" onClick={() => saveEditedResult(result)}>Save</button>
                                  <button type="button" className="row-action action-cancel" onClick={cancelEditingResult}>Cancel</button>
                                </>
                              ) : (
                                <>
                                  {result.status === 'Scanned' && (
                                    <button type="button" className="row-action action-edit" onClick={() => startEditingResult(result)}>Edit</button>
                                  )}
                                  <button type="button" className="row-action action-delete" onClick={() => deleteResult(result)}>Delete</button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr id={detailsId} className="detail-row">
                            <td colSpan={7}>
                              <div className="detail-panel">
                                <div className="detail-heading">
                                  <div><span className="eyebrow">PRIVATE TEACHER VIEW</span><h3>{result.student_name || 'Unknown student'}{result.roll && result.roll !== 'Unknown' ? ` · Roll ${result.roll}` : ''}</h3></div>
                                  <span className="detail-score">{result.score}/{result.total || 40} correct · Full marks {result.full_mark ?? result.total ?? 40}</span>
                                </div>
                                {result.scoreEdited && <p className="edited-score-note">The score was adjusted by the teacher; the answer-by-answer review below shows the original scan.</p>}
                                <p className="detail-legend"><span className="legend-correct">✓</span> Correct <span className="legend-incorrect">×</span> Incorrect or unanswered <span className="legend-review">!</span> Blank or unclear answers should be checked against the photo</p>
                                <div className="answer-grid">
                                  {result.details.map((detail) => (
                                    <div key={detail.question} className={`answer-card ${detail.isCorrect ? 'answer-correct' : 'answer-incorrect'}`}>
                                      <span className="answer-question">Q{String(detail.question).padStart(2, '0')}</span>
                                      <span className="answer-result">{detail.isCorrect ? '✓' : '×'}</span>
                                      <span className="answer-student">Student <strong>{detail.detected === 'N/A' ? 'Blank' : detail.detected}</strong></span>
                                      <span className="answer-correct-key">Key <strong>{detail.correct}</strong></span>
                                      {detail.detected === 'N/A' && (
                                        <span className="answer-confidence">
                                          Blank or unclear · check photo
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-results">
              <div className="empty-illustration" aria-hidden="true"><span>✳</span><i>✓</i></div>
              <h3>Your class results will show up here</h3>
              <p>Once you scan a sheet, student scores will be ready for you to review and export.</p>
            </div>
          )}
        </section>

        <footer className="page-footer">
          <p className="footer-tagline"><span>✳</span> One scan at a time, one student at a time. <span>✳</span></p>
          <p className="footer-faq-link"><a href="/free-omr-scanner/">How it works · FAQs</a></p>
          <div className="footer-meta">
            <p className="footer-credits">© 2026 ChemXact <span aria-hidden="true">·</span> Created by ChemXact</p>
            <p className="footer-contact">
              <a href="mailto:chemxact.edu@gmail.com">chemxact.edu@gmail.com</a>
              <span aria-hidden="true">·</span>
              <a href="https://chemxact.in" target="_blank" rel="noreferrer">chemxact.in</a>
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}

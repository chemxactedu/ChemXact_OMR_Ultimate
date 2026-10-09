import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, WidthType } from 'docx';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { auth, loginWithGoogle, logoutUser } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:8001' : '')
).trim().replace(/[/.]+$/, '');
const USAGE_FETCH_RETRY_DELAYS = [1000, 2000, 4000, 8000, 10000, 10000];

async function fetchUsageWithRetry(url, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (requestError) {
      if (!(requestError instanceof TypeError) || attempt >= USAGE_FETCH_RETRY_DELAYS.length) {
        throw requestError;
      }
      await new Promise((resolve) => window.setTimeout(resolve, USAGE_FETCH_RETRY_DELAYS[attempt]));
    }
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

export default function App() {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [answerKey, setAnswerKey] = useState('');
  const [fullMarks, setFullMarks] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [expandedResultIndex, setExpandedResultIndex] = useState(null);
  const [editingResultId, setEditingResultId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');
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
        const data = await response.json();
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
    try {
      await loginWithGoogle();
    } catch (loginError) {
      const message = loginError.code === 'auth/popup-blocked'
        ? 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.'
        : loginError.code === 'auth/popup-closed-by-user'
          ? 'The Google sign-in window was closed before login finished. Please try again.'
          : loginError.code === 'auth/network-request-failed'
            ? 'Google sign-in could not reach Firebase. Check your connection, VPN, or ad blocker and try again.'
            : `Login failed: ${loginError.message}`;
      setError(message);
    }
  };

  const handleSelectFiles = (event) => {
    const files = Array.from(event.target.files || []);
    setSelectedFiles((current) => [...current, ...files]);
    setError('');
    setNotice('');
    event.target.value = '';
  };

  const handleScan = async () => {
    if (!selectedFiles.length) {
      setError('Select at least one OMR sheet image.');
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

    setIsScanning(true);
    setError('');
    setNotice('');
    try {
      const token = await user.getIdToken();
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      formData.append('answer_key', normalizedKey);

      const response = await fetch(`${API_BASE_URL}/api/bulk-scan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Scan request failed.');

      setResults((current) => [
        ...current,
        ...data.results.map((result) => ({
          ...result,
          full_mark: fullMarkValue,
          id: createResultId(),
        })),
      ]);
      const retryableFileIndexes = data.results
        .flatMap((result, index) => (result.status === 'Scanned' ? [] : [index]));
      setSelectedFiles(retryableFileIndexes
        .map((index) => selectedFiles[index])
        .filter(Boolean));
      setUsage(data.usage);
      const completed = data.results.filter((result) => result.status === 'Scanned').length;
      const failed = data.results.filter((result) => result.status === 'Failed').length;
      setNotice(
        `${completed} sheet${completed === 1 ? '' : 's'} scanned` +
        `${failed ? `; ${failed} failed` : ''}.` +
        (failed ? ' Failed sheets remain selected so you can retry.' : '') +
        (data.quota_reached ? ' Daily limit reached; unscanned images are still selected for tomorrow.' : ''),
      );
    } catch (scanError) {
      setError(scanError instanceof TypeError && scanError.message === 'Failed to fetch'
        ? 'Could not reach the scan service. Check VITE_API_BASE_URL and make sure Render CORS_ORIGINS includes this website domain.'
        : scanError.message || 'Could not connect to the scan server.');
    } finally {
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
            <span><strong>OMR</strong><small>POWERED BY CHEMXACT</small></span>
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
          <span className="eyebrow">A little help for big ideas</span>
          <h1>Make room for<br /><em>more teaching.</em></h1>
          <p className="login-copy">Scan answer sheets, spot learning wins, and get back to the moments that matter in your classroom.</p>
          {error && <p role="alert" className="alert alert-error">{error}</p>}
          <button onClick={handleLogin} className="button button-primary login-button">
            <span className="google-mark" aria-hidden="true">G</span>
            Continue with Google
            <span aria-hidden="true">→</span>
          </button>
          <p className="login-footnote"><span>✦</span> Made for curious classrooms</p>
        </main>
      </div>
    );
  }

  const quotaReached = usage && !usage.is_premium && usage.remaining === 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><span>✳</span></span>
          <span><strong>OMR</strong><small>POWERED BY CHEMXACT</small></span>
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
            <p><span className="ousi-wordmark">Ousi</span> AI helps turn answer sheets into a clearer picture of how your students are learning.</p>
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
            <div><span className="stat-label">Sheets checked</span><strong>{scannedResults.length}</strong><small>in this session</small></div>
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
          </article>

          <article className="workspace-card upload-card">
            <div className="card-heading">
              <span className="step-badge step-mint">02</span>
              <div><span className="card-kicker">THEN, THE FUN PART</span><h3>Add student sheets</h3></div>
              <span className="heading-doodle upload-doodle" aria-hidden="true">↥</span>
            </div>
            <p className="card-description">Choose clear, full-page photos. You can scan a whole class at once.</p>
            <label className="upload-zone">
              <input type="file" accept="image/*" multiple onChange={handleSelectFiles} />
              <span className="upload-icon" aria-hidden="true">↥</span>
              <span className="upload-title">{selectedFiles.length ? 'Add a few more sheets' : 'Drop your sheets here'}</span>
              <span className="upload-hint">or <strong>browse files</strong> · JPG, PNG or WEBP</span>
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
            {isScanning && <p className="scan-helper">Ousi’s taking it from here. Sit back and relax—we’ll let you know as soon as your sheets are ready.</p>}
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
              <p>Answer details stay tucked away for your teacher review.</p>
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

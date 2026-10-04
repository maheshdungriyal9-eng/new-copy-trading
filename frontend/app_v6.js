// Force default user session immediately on script load
const defaultUser = { id: 'usr_default', name: 'Mahesh Kumar', email: 'mahesh@gmail.com' };
localStorage.setItem('currentUser', JSON.stringify(defaultUser));

// Intercept global fetch to automatically append X-User-Id header
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
  const user = JSON.parse(localStorage.getItem('currentUser')) || defaultUser;
  if (user && user.id) {
    options.headers = options.headers || {};
    options.headers['X-User-Id'] = user.id;
  }
  return originalFetch(url, options);
};

// Global error logging to backend
window.addEventListener('error', function(event) {
  const errMessage = event.error ? event.error.message : event.message;
  const stack = event.error ? event.error.stack : '';
  console.error('[Browser Error]', errMessage);
  
  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Frontend Error: ${errMessage}`,
      type: 'error',
      details: { stack, url: event.filename, line: event.lineno }
    })
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', function(event) {
  const errMessage = event.reason ? (event.reason.message || event.reason) : 'Promise rejection';
  const stack = event.reason ? event.reason.stack : '';
  console.error('[Unhandled Rejection]', errMessage);
  
  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Frontend Promise Rejection: ${errMessage}`,
      type: 'error',
      details: { stack }
    })
  }).catch(() => {});
});

// Global State
let accounts = [];
let mappings = [];
let groups = [];
let activeTab = 'overview';
let logPoller = null;

// Premium Toast Notification Utility
function showNotification(message, type = 'success') {
  let container = document.getElementById('notification-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'notification-container';
    container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 10000; display: flex; flex-direction: column; gap: 10px; pointer-events: none;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.style.cssText = `
    padding: 14px 22px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
    transform: translateY(-20px);
    opacity: 0;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
  `;

  if (type === 'success') {
    toast.style.background = 'rgba(16, 185, 129, 0.85)'; // Emerald Green
    toast.innerHTML = '<i class="fa-solid fa-circle-check" style="color: #34D399;"></i> ' + message;
  } else if (type === 'error') {
    toast.style.background = 'rgba(239, 68, 68, 0.85)'; // Red
    toast.innerHTML = '<i class="fa-solid fa-circle-xmark" style="color: #F87171;"></i> ' + message;
  } else {
    toast.style.background = 'rgba(59, 130, 246, 0.85)'; // Blue
    toast.innerHTML = '<i class="fa-solid fa-circle-info" style="color: #60A5FA;"></i> ' + message;
  }

  container.appendChild(toast);

  // Trigger animation
  setTimeout(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  }, 10);

  // Dismiss after 4.5 seconds
  setTimeout(() => {
    toast.style.transform = 'translateY(-20px)';
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4500);
}
let watchlistSymbols = [];
let currentWatchlistTab = '1';
let watchlistPrices = {};
let pricePoller = null;

// Modal History Back Interception
let modalHistoryStates = [];

function pushModalHistory(modalName) {
  window.history.pushState({ modalOpen: true, modalName: modalName }, '');
  modalHistoryStates.push(modalName);
}

function popModalHistory(modalName) {
  const idx = modalHistoryStates.lastIndexOf(modalName);
  if (idx !== -1) {
    modalHistoryStates.splice(idx, 1);
    if (window.history.state && window.history.state.modalOpen) {
      window.history.back();
    }
  }
}

window.addEventListener('popstate', (e) => {
  if (modalHistoryStates.length > 0) {
    const closedModal = modalHistoryStates.pop();
    if (closedModal === 'stock-details') {
      closeStockDetails(true);
    } else if (closedModal === 'order-placement') {
      closeOrderPlacement(true);
    } else if (closedModal === 'group-modal') {
      if (typeof window.closeGroupModal === 'function') {
        window.closeGroupModal(true);
      }
    } else if (closedModal === 'logs-modal') {
      if (typeof window.closeLogsModal === 'function') {
        window.closeLogsModal(true);
      }
    }
  }
});
let portfolioPoller = null;
let isFetchingPortfolio = false;
let positionsTotalBarExpanded = false;
let currentSelectedStock = null;
let currentOrdersData = { pending: [], executed: [] };
let currentHoldingsData = [];

// Position Exit state variables
let isExitOrder = false;
let exitPositionQty = 0;
let exitPositionAccount = '';
let exitPositionProduct = '';

function getWatchlistPrice(symbol) {
  if (!symbol) return null;
  
  const cleanSym = symbol.toUpperCase().trim();
  const hyphenated = cleanSym.replace(/\s+/g, '-');
  const stripped = cleanSym.replace(/\s+EQ$/i, '').replace(/-EQ$/i, '');
  
  const candidates = [
    cleanSym,
    hyphenated,
    stripped,
    `${stripped}-EQ`,
    `${cleanSym}-EQ`
  ];
  
  for (const cand of candidates) {
    if (watchlistPrices[cand]) {
      return watchlistPrices[cand];
    }
  }
  return null;
}

function getLiveOrStaticLtp(hold) {
  const symbol = hold.tradingsymbol || hold.scripname || '';
  const priceData = getWatchlistPrice(symbol);
  if (priceData && priceData.ltp !== undefined) {
    return parseFloat(priceData.ltp);
  }
  return parseFloat(hold.ltp || hold.LTP || hold.closeprice || hold.closePrice || hold.rate || hold.averageprice || hold.buyavgprice || 0);
}

function getLiveOrStaticPrevClose(hold) {
  const symbol = hold.tradingsymbol || hold.scripname || '';
  const priceData = getWatchlistPrice(symbol);
  if (priceData && priceData.prevClose !== undefined) {
    return parseFloat(priceData.prevClose);
  }
  return parseFloat(hold.close || hold.closeprice || hold.closePrice || hold.averageprice || hold.buyavgprice || 0);
}

function safeParseFloat(val, fallback = 0) {
  if (val === null || val === undefined || val === '') return fallback;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? fallback : parsed;
}

function parseOrderTime(o) {
  if (!o) return 0;
  const timeStr = o.updatetime || o.recordinserttime || o.orderdatetime || o.createtime || o.updateTime || '';
  if (!timeStr) return 0;
  
  if (!isNaN(timeStr) && typeof timeStr !== 'boolean') {
    const num = Number(timeStr);
    return num < 10000000000 ? num * 1000 : num;
  }
  
  let parsed = Date.parse(timeStr);
  if (!isNaN(parsed)) return parsed;

  try {
    const normalized = timeStr.replace(/-/g, ' ').replace(/,/g, '');
    let parsedNorm = Date.parse(normalized);
    if (!isNaN(parsedNorm)) return parsedNorm;
    
    const match = timeStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[,\s]+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (match) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const year = parseInt(match[3], 10);
      const hrs = parseInt(match[4], 10);
      const mins = parseInt(match[5], 10);
      const secs = parseInt(match[6], 10);
      return new Date(year, month, day, hrs, mins, secs).getTime();
    }
  } catch (e) {
    // ignore
  }
  
  return 0;
}

function getPositionAvgPrice(pos) {
  if (!pos) return 0;
  const qty = pos.netqty !== undefined ? safeParseFloat(pos.netqty) : (pos.buyquantity !== undefined && pos.sellquantity !== undefined ? safeParseFloat(pos.buyquantity) - safeParseFloat(pos.sellquantity) : safeParseFloat(pos.buyquantity || 0));
  const avgNet = safeParseFloat(pos.avgnetprice);
  if (avgNet !== 0) return avgNet;
  
  const net = safeParseFloat(pos.netprice);
  if (net !== 0) return net;
  
  const buyAvg = safeParseFloat(pos.buyavgprice || pos.averageprice);
  const sellAvg = safeParseFloat(pos.sellavgprice);
  
  if (qty < 0) {
    return sellAvg !== 0 ? sellAvg : buyAvg;
  } else if (qty > 0) {
    return buyAvg !== 0 ? buyAvg : sellAvg;
  } else {
    return buyAvg !== 0 ? buyAvg : (sellAvg !== 0 ? sellAvg : 0);
  }
}

// API Base URL (running on same local port)
const API_BASE = '/api';

// Firebase Auth State
let firebaseInitialized = false;
let confirmationResult = null;

async function initFirebase() {
  try {
    const res = await originalFetch(`${API_BASE}/auth/firebase-config`);
    const config = await res.json();
    if (config && config.apiKey) {
      firebase.initializeApp(config);
      firebaseInitialized = true;
      console.log('[Auth] Firebase initialized successfully.');
      
      // Initialize invisible Recaptcha
      window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
        'size': 'invisible',
        'callback': (response) => {
          console.log('[Auth] Recaptcha solved.');
        }
      });
    } else {
      console.log('[Auth] No Firebase configuration found. Running in MOCK mode.');
    }
  } catch (e) {
    console.error('[Auth] Failed to initialize Firebase:', e);
  }
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupMobileNav();
  setupEventListeners();
  setupOTPAutoAdvance();
  setupPullToRefresh();
  initSwipeNavigation();
  
  // Initialize Firebase Auth (available in background if needed later)
  initFirebase();
  
  // Bypass login screen by forcing default user session
  localStorage.setItem('currentUser', JSON.stringify(defaultUser));
  
  const authEl = document.getElementById('auth-screen');
  if (authEl) {
    authEl.classList.add('hidden');
    authEl.style.display = 'none';
  }
  updateUserDisplay(defaultUser);
  loadData();
  startLogPolling();
  startPricePolling();
  
  // Initialize element locations based on screen size
  relocateElements();
  window.addEventListener('resize', relocateElements);
  
  // Initialize bottom sheet swipe-to-dismiss handlers
  initBottomSheetSwipeDismiss();
});

// Authentication UI & Actions
window.switchAuthTab = function(tab) {
  const tabPhone = document.getElementById('auth-tab-phone');
  const tabGoogle = document.getElementById('auth-tab-google');
  const sectionPhone = document.getElementById('auth-phone-section');
  const sectionGoogle = document.getElementById('auth-google-section');

  if (tab === 'phone') {
    if (tabPhone) tabPhone.classList.add('active');
    if (tabGoogle) tabGoogle.classList.remove('active');
    if (sectionPhone) sectionPhone.classList.remove('hidden');
    if (sectionGoogle) sectionGoogle.classList.add('hidden');
  } else {
    if (tabPhone) tabPhone.classList.remove('active');
    if (tabGoogle) tabGoogle.classList.add('active');
    if (sectionPhone) sectionPhone.classList.add('hidden');
    if (sectionGoogle) sectionGoogle.classList.remove('hidden');
  }
};

window.backToPhoneInput = function() {
  const stepPhone = document.getElementById('auth-step-phone');
  const stepOtp = document.getElementById('auth-step-otp');
  if (stepPhone) stepPhone.classList.remove('hidden');
  if (stepOtp) stepOtp.classList.add('hidden');
};

// Send OTP
window.lastReceivedOTP = null;
let isAutoTypingOTP = false;
let smsToastTimeout = null;

function playNotificationBeep() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    // Double tone chime beep
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc1.frequency.setValueAtTime(880.00, ctx.currentTime + 0.08); // A5
    
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc2.frequency.setValueAtTime(880.00, ctx.currentTime + 0.08);
    
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    
    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.35);
    osc2.stop(ctx.currentTime + 0.35);
  } catch (e) {
    console.log('Audio beep blocked or unsupported:', e);
  }
}

window.triggerAutoOTPDetect = function() {
  if (isAutoTypingOTP || !window.lastReceivedOTP) return;
  isAutoTypingOTP = true;

  // Dismiss Toast with animation
  window.dismissSMSToast();

  const otp = window.lastReceivedOTP;
  const digits = document.querySelectorAll('.otp-digit');
  
  // Clear digits first
  digits.forEach(el => el.value = '');

  // Sequential typing animation
  let index = 0;
  function typeNextDigit() {
    if (index < 6) {
      const input = digits[index];
      input.focus();
      input.value = otp[index];
      
      // Trigger scaling animation in styling
      input.style.transform = 'scale(1.15)';
      input.style.borderColor = 'var(--cyan)';
      input.style.background = 'rgba(0, 212, 255, 0.08)';
      
      setTimeout(() => {
        input.style.transform = 'scale(1)';
        input.style.borderColor = 'var(--border-focus)';
        input.style.background = 'rgba(13, 148, 136, 0.05)';
      }, 100);

      index++;
      setTimeout(typeNextDigit, 150); // 150ms delay per digit
    } else {
      isAutoTypingOTP = false;
      window.dismissAutofillSuggestion();
      // Auto verify code
      window.handleVerifyOTP();
    }
  }

  setTimeout(typeNextDigit, 200);
};

window.dismissSMSToast = function() {
  const toast = document.getElementById('sms-toast');
  if (toast) {
    toast.classList.add('hidden');
  }
  if (smsToastTimeout) {
    clearTimeout(smsToastTimeout);
    smsToastTimeout = null;
  }
};

window.dismissAutofillSuggestion = function() {
  const suggestion = document.getElementById('otp-autofill-suggestion');
  if (suggestion) {
    suggestion.classList.add('hidden');
  }
};

window.handleSendOTP = async function() {
  const phoneInput = document.getElementById('auth-phone-input');
  const phone = phoneInput ? phoneInput.value.trim() : '';
  if (!/^\d{10}$/.test(phone)) {
    alert('Please enter a valid 10-digit mobile number.');
    return;
  }

  const btn = document.getElementById('btn-send-otp');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending OTP...';
  }

  if (firebaseInitialized) {
    try {
      const phoneNumber = '+91' + phone;
      const appVerifier = window.recaptchaVerifier;
      const confirmation = await firebase.auth().signInWithPhoneNumber(phoneNumber, appVerifier);
      confirmationResult = confirmation;

      const stepPhone = document.getElementById('auth-step-phone');
      const stepOtp = document.getElementById('auth-step-otp');
      if (stepPhone) stepPhone.classList.add('hidden');
      if (stepOtp) stepOtp.classList.remove('hidden');

      // Clear any previous values and focus on the first OTP digit
      const digits = document.querySelectorAll('.otp-digit');
      digits.forEach(el => el.value = '');
      if (digits.length > 0) {
        setTimeout(() => digits[0].focus(), 150);
      }
      console.log('[Auth] Firebase OTP code sent successfully.');
    } catch (err) {
      console.error('[Auth] Firebase signInWithPhoneNumber failed:', err);
      alert('Error sending OTP via Firebase: ' + (err.message || err));
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Get OTP Code';
      }
    }
  } else {
    // Mock OTP Fallback
    try {
      const response = await originalFetch(`${API_BASE}/auth/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      if (response.ok) {
        const data = await response.json();
        window.lastReceivedOTP = data.otp; // Cache the OTP code

        const stepPhone = document.getElementById('auth-step-phone');
        const stepOtp = document.getElementById('auth-step-otp');
        if (stepPhone) stepPhone.classList.add('hidden');
        if (stepOtp) stepOtp.classList.remove('hidden');

        // Clear any previous values and focus on the first OTP digit
        const digits = document.querySelectorAll('.otp-digit');
        digits.forEach(el => el.value = '');
        if (digits.length > 0) {
          setTimeout(() => digits[0].focus(), 150);
        }

        // Show iOS/Android mock SMS Toast
        const toast = document.getElementById('sms-toast');
        const smsCode = document.getElementById('sms-otp-code');
        if (toast && smsCode && window.lastReceivedOTP) {
          smsCode.textContent = window.lastReceivedOTP;
          toast.classList.remove('hidden');
          
          // Play notification chime sound
          playNotificationBeep();

          // Auto dismiss after 10 seconds
          if (smsToastTimeout) clearTimeout(smsToastTimeout);
          smsToastTimeout = setTimeout(() => {
            window.dismissSMSToast();
          }, 10000);
        }

        // Show Autofill suggestion pill
        const suggestion = document.getElementById('otp-autofill-suggestion');
        const suggestionVal = document.getElementById('suggestion-otp-val');
        if (suggestion && suggestionVal && window.lastReceivedOTP) {
          suggestionVal.textContent = window.lastReceivedOTP;
          suggestion.classList.remove('hidden');
        }

      } else {
        alert('Failed to send OTP. Try again.');
      }
    } catch (err) {
      alert('Connection error.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Get OTP Code';
      }
    }
  }
};

// Setup Modern OTP Input event listeners
function setupOTPAutoAdvance() {
  const digits = document.querySelectorAll('.otp-digit');
  digits.forEach((input, index) => {
    // Auto advance focus
    input.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val && !/^\d$/.test(val)) {
        e.target.value = '';
        return;
      }
      
      if (val && index < digits.length - 1) {
        digits[index + 1].focus();
      }
      
      // Auto submit check
      checkAndAutoSubmitOTP();
    });

    // Backspace focus backward
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        if (!e.target.value && index > 0) {
          digits[index - 1].focus();
          digits[index - 1].value = '';
        }
      }
    });

    // Paste handling
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pastedData = (e.clipboardData || window.clipboardData).getData('text').trim();
      if (/^\d{6}$/.test(pastedData)) {
        for (let i = 0; i < digits.length; i++) {
          digits[i].value = pastedData[i];
        }
        digits[digits.length - 1].focus();
        checkAndAutoSubmitOTP();
      }
    });
  });
}

function checkAndAutoSubmitOTP() {
  const digits = document.querySelectorAll('.otp-digit');
  let otp = '';
  digits.forEach(el => otp += el.value.trim());
  if (otp.length === 6) {
    handleVerifyOTP();
  }
}

// Verify OTP
window.handleVerifyOTP = async function() {
  const phoneVal = document.getElementById('auth-phone-input') ? document.getElementById('auth-phone-input').value.trim() : '';
  
  // Read OTP from the 6 individual inputs
  const digits = document.querySelectorAll('.otp-digit');
  let otp = '';
  digits.forEach(el => otp += el.value.trim());

  if (otp.length < 6) {
    alert('Please enter the 6-digit OTP code.');
    return;
  }

  const btn = document.getElementById('btn-verify-otp');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
  }

  if (firebaseInitialized && confirmationResult) {
    try {
      const result = await confirmationResult.confirm(otp);
      const user = result.user;
      
      const response = await originalFetch(`${API_BASE}/auth/firebase-success`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: user.phoneNumber,
          email: user.email || '',
          name: user.displayName || ''
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        loginUser(data.user);
      } else {
        const err = await response.json();
        alert('Server login failed: ' + (err.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('[Auth] Firebase confirmation failed:', err);
      alert('Invalid OTP code. Please enter the correct code.');
      digits.forEach(el => el.value = '');
      if (digits.length > 0) digits[0].focus();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Verify & Login';
      }
    }
  } else {
    // Mock OTP Verification Fallback
    try {
      const response = await originalFetch(`${API_BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phoneVal, otp })
      });
      if (response.ok) {
        const data = await response.json();
        loginUser(data.user);
      } else {
        alert('Invalid OTP code. Please check your backend terminal console.');
        // Clear inputs for retry
        digits.forEach(el => el.value = '');
        if (digits.length > 0) digits[0].focus();
      }
    } catch (err) {
      alert('Connection error.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Verify & Login';
      }
    }
  }
};

// Google Login Mock
window.handleGoogleLogin = async function() {
  if (firebaseInitialized) {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const result = await firebase.auth().signInWithPopup(provider);
      const user = result.user;
      
      const response = await originalFetch(`${API_BASE}/auth/firebase-success`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          phone: user.phoneNumber || '',
          name: user.displayName || ''
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        loginUser(data.user);
      } else {
        const err = await response.json();
        alert('Server login failed: ' + (err.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('[Auth] Firebase Google login failed:', err);
      alert('Google Login failed: ' + (err.message || err));
    }
  } else {
    // Mock Google Login Fallback
    const mockAccounts = [
      { email: 'mahesh.kumar@gmail.com', name: 'Mahesh Kumar' },
      { email: 'rishabh.jain@gmail.com', name: 'Rishabh Jain' },
      { email: 'copytrader.user@gmail.com', name: 'Premium Trader' }
    ];

    const choice = prompt(
      "Choose simulated Google Account:\n1. Mahesh Kumar (mahesh.kumar@gmail.com)\n2. Rishabh Jain (rishabh.jain@gmail.com)\n3. Custom Email...",
      "1"
    );

    let selectedAccount;
    if (choice === "1") {
      selectedAccount = mockAccounts[0];
    } else if (choice === "2") {
      selectedAccount = mockAccounts[1];
    } else if (choice === "3" || (choice && choice.includes("@"))) {
      let email = choice.includes("@") ? choice : prompt("Enter custom Google email:");
      if (!email) return;
      selectedAccount = { email, name: email.split('@')[0] };
    } else {
      selectedAccount = mockAccounts[2];
    }

    try {
      const response = await originalFetch(`${API_BASE}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedAccount)
      });
      if (response.ok) {
        const data = await response.json();
        loginUser(data.user);
      }
    } catch (e) {
      alert('Google login connection error.');
    }
  }
};

function loginUser(user) {
  localStorage.setItem('currentUser', JSON.stringify(user));
  const authEl = document.getElementById('auth-screen');
  if (authEl) authEl.classList.add('hidden');
  updateUserDisplay(user);
  loadData();
  startLogPolling();
  startPricePolling();
}

window.handleLogout = function() {
  if (confirm('Are you sure you want to log out?')) {
    const defaultUser = { id: 'usr_default', name: 'Mahesh Kumar', email: 'mahesh@gmail.com' };
    localStorage.setItem('currentUser', JSON.stringify(defaultUser));
    window.location.reload();
  }
};

function updateUserDisplay(user) {
  const sidebarDisplay = document.getElementById('user-display-name');
  const accountsDisplay = document.getElementById('account-user-badge');

  if (user) {
    const displayName = user.name || user.email || user.phone || 'User';
    if (sidebarDisplay) sidebarDisplay.textContent = displayName;
    if (accountsDisplay) accountsDisplay.textContent = `Logged in as: ${displayName}`;
  } else {
    if (sidebarDisplay) sidebarDisplay.textContent = 'Guest';
    if (accountsDisplay) accountsDisplay.textContent = 'Logged in as: Guest';
  }
}

// Setup Tab Navigation
function setupTabs() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });
}

// Setup Mobile Bottom Navigation Tabs
function setupMobileNav() {
  const mobileBtns = document.querySelectorAll('.mobile-nav-btn');
  mobileBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  activeTab = tabId;

  // Hide global positions total bar when leaving orders tab
  if (tabId !== 'orders') {
    const posBar = document.getElementById('positions-total-fixed-bar');
    if (posBar) posBar.style.display = 'none';
    const posDetail = document.getElementById('positions-total-detail-drawer');
    if (posDetail) posDetail.style.display = 'none';
  }

  // Update desktop sidebar buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });

  // Update mobile bottom bar buttons
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  
  // Update contents
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.toggle('active', tab.getAttribute('id') === `tab-${tabId}`);
  });

  // Clear any existing portfolio poller
  if (portfolioPoller) {
    clearInterval(portfolioPoller);
    portfolioPoller = null;
  }

  // Perform tab-specific refreshes
  if (tabId === 'overview') {
    renderTopologyMap();
    renderQuickStatusList();
  } else if (tabId === 'portfolio' || tabId === 'orders') {
    populatePortfolioDropdown();
    refreshPortfolio(false);
    portfolioPoller = setInterval(() => refreshPortfolio(true), 2000);
    if (tabId === 'orders') {
      setOrdersMainTab(ordersActiveMainTab);
    }
  } else if (tabId === 'simulator') {
    populateSimulatorDropdowns();
  }

  // Run DOM relocation for newly selected tab elements
  relocateElements();

  // Reset scroll position of content area on tab switch
  const contentArea = document.querySelector('.content-area');
  if (contentArea) {
    contentArea.scrollTop = 0;
  }
}

// Relocate dashboard and portfolio sections dynamically between desktop and mobile layouts
function relocateElements() {
  const isMobile = window.innerWidth <= 768;

  // 1. Watchlist Card relocation
  const watchlistCard = document.getElementById('watchlist-card');
  const desktopWatchlist = document.getElementById('desktop-watchlist-container');
  const mobileWatchlist = document.getElementById('mobile-watchlist-container');
  if (watchlistCard) {
    if (isMobile && mobileWatchlist && watchlistCard.parentElement !== mobileWatchlist) {
      mobileWatchlist.appendChild(watchlistCard);
    } else if (!isMobile && desktopWatchlist && watchlistCard.parentElement !== desktopWatchlist) {
      desktopWatchlist.appendChild(watchlistCard);
    }
  }

  // 3. Pending Orders Card relocation
  const pendingCard = document.getElementById('pending-orders-card');
  const desktopPending = document.getElementById('desktop-pending-container');
  const mobilePending = document.getElementById('mobile-pending-container');
  if (pendingCard) {
    if (isMobile && mobilePending && pendingCard.parentElement !== mobilePending) {
      mobilePending.appendChild(pendingCard);
    } else if (!isMobile && desktopPending && pendingCard.parentElement !== desktopPending) {
      desktopPending.appendChild(pendingCard);
    }
  }

  // 4. Executed Orders Card relocation
  const executedCard = document.getElementById('executed-orders-card');
  const desktopExecuted = document.getElementById('desktop-executed-container');
  const mobileExecuted = document.getElementById('mobile-executed-container');
  if (executedCard) {
    if (isMobile && mobileExecuted && executedCard.parentElement !== mobileExecuted) {
      mobileExecuted.appendChild(executedCard);
    } else if (!isMobile && desktopExecuted && executedCard.parentElement !== desktopExecuted) {
      desktopExecuted.appendChild(executedCard);
    }
  }

  // 5. App Header mobile handling (always hidden on mobile to maximize screen space)
  const headerEl = document.getElementById('app-header');
  if (headerEl) {
    if (isMobile) {
      headerEl.style.setProperty('display', 'none', 'important');
    } else {
      headerEl.style.removeProperty('display');
    }
  }

  // 6. Positions Card relocation
  const positionsCard = document.getElementById('positions-card');
  const desktopPositions = document.getElementById('desktop-positions-container');

  if (positionsCard) {
    if (!isMobile) {
      if (desktopPositions && positionsCard.parentElement !== desktopPositions) {
        desktopPositions.appendChild(positionsCard);
      }
    }
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Account Form Toggles
  document.getElementById('btn-show-add-account').addEventListener('click', showAddAccountForm);
  document.getElementById('btn-cancel-account').addEventListener('click', hideAccountForm);
  document.getElementById('btn-discard-account').addEventListener('click', hideAccountForm);
  
  // Broker-specific Fields Toggle
  document.getElementById('acc-broker').addEventListener('change', (e) => {
    toggleBrokerFields(e.target.value);
  });

  // Paper Trading Toggle
  document.getElementById('acc-is-simulated').addEventListener('change', updateSimulationFieldsVisibility);

  // Connection Route Toggles
  document.querySelectorAll('input[name="conn-route-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const proxyInput = document.getElementById('acc-proxyurl');
      if (e.target.value === 'custom') {
        proxyInput.style.display = 'block';
        proxyInput.required = true;
      } else {
        proxyInput.style.display = 'none';
        proxyInput.required = false;
        proxyInput.value = '';
      }
    });
  });

  // Account Form Submit
  document.getElementById('account-form').addEventListener('submit', handleAccountSubmit);

  // Mappings Action
  document.getElementById('btn-add-mapping-row').addEventListener('click', addMappingRow);
  document.getElementById('btn-save-mappings').addEventListener('click', saveMappings);

  // Simulator Form
  document.getElementById('simulator-form').addEventListener('submit', handleSimulatorSubmit);
  document.getElementById('sim-type').addEventListener('change', (e) => {
    const priceGroup = document.getElementById('sim-price-group');
    if (e.target.value === 'MARKET') {
      priceGroup.style.opacity = '0.4';
      document.getElementById('sim-price').disabled = true;
    } else {
      priceGroup.style.opacity = '1';
      document.getElementById('sim-price').disabled = false;
    }
  });

  // Console actions
  document.getElementById('btn-clear-logs').addEventListener('click', clearLogs);

  // Portfolio & Mobile Orders Selection changes (synchronized)
  document.getElementById('portfolio-account').addEventListener('change', (e) => {
    const ordersSelect = document.getElementById('orders-account-select');
    if (ordersSelect) {
      ordersSelect.value = e.target.value;
    }
    refreshPortfolio();
  });

  const ordersSelect = document.getElementById('orders-account-select');
  if (ordersSelect) {
    ordersSelect.addEventListener('change', (e) => {
      const portfolioSelect = document.getElementById('portfolio-account');
      if (portfolioSelect) {
        portfolioSelect.value = e.target.value;
      }
      refreshPortfolio();
    });
  }

  // Watchlist Actions
  const searchInput = document.getElementById('watchlist-search');
  const suggestionsBox = document.getElementById('watchlist-suggestions');

  // Watchlist Swipe Gestures (Left swipe ➜ Tab 2, Right swipe ➜ Tab 1)
  const watchlistCard = document.getElementById('watchlist-card');
  if (watchlistCard) {
    let touchStartX = 0;
    let touchStartY = 0;
    let touchEndX = 0;
    let touchEndY = 0;

    watchlistCard.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
      touchStartY = e.changedTouches[0].screenY;
    }, { passive: true });

    watchlistCard.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX;
      touchEndY = e.changedTouches[0].screenY;
      
      const deltaX = touchEndX - touchStartX;
      const deltaY = touchEndY - touchStartY;
      
      // Ensure horizontal swipe
      if (Math.abs(deltaX) > 60 && Math.abs(deltaY) < 40) {
        if (deltaX < 0) {
          if (currentWatchlistTab === '1') {
            switchWatchlistTab(2);
          }
        } else {
          if (currentWatchlistTab === '2') {
            switchWatchlistTab(1);
          }
        }
      }
    }, { passive: true });
  }

  const addBtn = document.getElementById('btn-add-watchlist');
  if (addBtn) addBtn.addEventListener('click', handleAddWatchlist);
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddWatchlist();
  });

  // Simple debounce helper
  function debounce(func, delay) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), delay);
    };
  }

  // Helper functions to show/hide watchlist indices header and manage full screen search state
  let currentSearchResults = [];
  let currentSearchFilter = 'all';
  let isOpeningSearch = false;

  function hideWatchlistIndices() {
    isOpeningSearch = true;
    setTimeout(() => { isOpeningSearch = false; }, 400);

    const card = document.getElementById('watchlist-card');
    if (card) {
      if (!card.classList.contains('search-active')) {
        // Push state into browser history to capture the swipe back gesture
        history.pushState({ searchActive: true }, '');
      }
      card.classList.add('search-active');
      document.body.classList.add('search-active-global');
    }
    const icon = document.getElementById('watchlist-search-icon');
    if (icon) {
      icon.className = 'fa-solid fa-arrow-left search-icon';
    }
    const indexHeader = document.querySelector('.wl-index-header');
    if (indexHeader) {
      indexHeader.classList.add('hidden');
    }
    const searchPlaceholder = document.getElementById('watchlist-search-desktop-placeholder');
    if (searchPlaceholder) {
      searchPlaceholder.style.marginTop = '0px';
    }
    const filterBar = document.getElementById('search-filter-bar');
    if (filterBar) {
      filterBar.classList.remove('hidden');
    }
    const clearBtn = document.getElementById('watchlist-search-clear');
    if (clearBtn && searchInput.value.trim().length > 0) {
      clearBtn.classList.remove('hidden');
    }

    // Force focus on searchInput after layout shift to bring up the keyboard
    setTimeout(() => {
      searchInput.focus();
    }, 50);
  }
  window.hideWatchlistIndices = hideWatchlistIndices;

  function showWatchlistIndices() {
    // If browser state is searchActive, trigger history back to sync with popstate
    if (history.state && history.state.searchActive) {
      history.back();
      return;
    }

    const card = document.getElementById('watchlist-card');
    if (card) {
      card.classList.remove('search-active');
      document.body.classList.remove('search-active-global');
    }
    const icon = document.getElementById('watchlist-search-icon');
    if (icon) {
      icon.className = 'fa-solid fa-magnifying-glass search-icon';
    }
    const indexHeader = document.querySelector('.wl-index-header');
    if (indexHeader) {
      indexHeader.classList.remove('hidden');
    }
    const searchPlaceholder = document.getElementById('watchlist-search-desktop-placeholder');
    if (searchPlaceholder) {
      searchPlaceholder.style.marginTop = '12px';
    }
    const filterBar = document.getElementById('search-filter-bar');
    if (filterBar) {
      filterBar.classList.add('hidden');
    }
    const clearBtn = document.getElementById('watchlist-search-clear');
    if (clearBtn) {
      clearBtn.classList.add('hidden');
    }
  }
  window.showWatchlistIndices = showWatchlistIndices;

  // Listen for browser back button / swipe back gesture to close search overlay
  window.addEventListener('popstate', (e) => {
    const card = document.getElementById('watchlist-card');
    if (card && card.classList.contains('search-active') && (!e.state || !e.state.searchActive)) {
      searchInput.value = '';
      suggestionsBox.innerHTML = '';
      suggestionsBox.classList.add('hidden');
      currentSearchResults = [];
      searchInput.blur();
      showWatchlistIndices(); // Restores layout directly since history state has been popped
    }
  });

  // Trigger overlay immediately on click, focus or touchstart
  searchInput.addEventListener('focus', hideWatchlistIndices);
  searchInput.addEventListener('click', hideWatchlistIndices);
  searchInput.addEventListener('touchstart', hideWatchlistIndices, { passive: true });

  // Click on search bar icon handling
  const searchIcon = document.getElementById('watchlist-search-icon');
  if (searchIcon) {
    searchIcon.addEventListener('click', (e) => {
      if (searchIcon.classList.contains('fa-arrow-left')) {
        e.stopPropagation();
        searchInput.value = '';
        suggestionsBox.innerHTML = '';
        suggestionsBox.classList.add('hidden');
        currentSearchResults = [];
        showWatchlistIndices();
      } else {
        // If it's a magnifying glass, focus input to activate search immediately
        searchInput.focus();
        hideWatchlistIndices();
      }
    });
  }

  // Click on search input wrapper also focuses and activates search
  const searchInputWrapper = document.querySelector('.search-input-wrapper');
  if (searchInputWrapper) {
    searchInputWrapper.addEventListener('click', (e) => {
      if (e.target !== searchInput && !e.target.closest('#watchlist-search-clear')) {
        searchInput.focus();
        hideWatchlistIndices();
      }
    });
  }

  // Close (X) button clears search text
  const clearBtn = document.getElementById('watchlist-search-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      searchInput.value = '';
      suggestionsBox.innerHTML = '';
      suggestionsBox.classList.add('hidden');
      clearBtn.classList.add('hidden');
      currentSearchResults = [];
      searchInput.focus();
    });
  }

  // Filter Tabs Event Listeners
  const filterTabs = document.querySelectorAll('.search-filter-tab');
  filterTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSearchFilter = tab.getAttribute('data-filter');
      renderSearchSuggestions();
    });
  });

  async function toggleWatchlistSymbol(symbol) {
    const isAlreadyIn = watchlistSymbols.includes(symbol);
    if (isAlreadyIn) {
      try {
        const response = await fetch(`${API_BASE}/watchlist/${encodeURIComponent(symbol)}?tab=${currentWatchlistTab}`, { method: 'DELETE' });
        if (response.ok) {
          const res = await response.json();
          watchlistSymbols = res.watchlist;
          renderWatchlistTable();
          renderSearchSuggestions();
        }
      } catch (err) {
        console.error('Failed to delete watchlist symbol:', err);
      }
    } else {
      if (watchlistSymbols.length >= 20) {
        showNotification("Watchlist limit reached (Max 20 symbols)", "error");
        return;
      }
      try {
        const response = await fetch(`${API_BASE}/watchlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, tab: currentWatchlistTab })
        });
        if (response.ok) {
          const res = await response.json();
          watchlistSymbols = res.watchlist;
          renderWatchlistTable();
          pollWatchlistPrices();
          renderSearchSuggestions();
        } else {
          alert('Failed to add symbol.');
        }
      } catch (err) {
        console.error('Failed to add watchlist symbol:', err);
      }
    }
  }
  window.toggleWatchlistSymbol = toggleWatchlistSymbol;

  function renderSearchSuggestions() {
    suggestionsBox.innerHTML = '';
    
    // Filter matches based on active tab
    const filtered = currentSearchResults.filter(item => {
      if (currentSearchFilter === 'all') return true;
      
      const symbol = item.symbol.toUpperCase();
      const exchange = (item.exchange || '').toUpperCase();
      
      const isFO = symbol.endsWith('FUT') || symbol.endsWith('CE') || symbol.endsWith('PE') ||
                  symbol.includes('-FUT') || symbol.includes('-CE') || symbol.includes('-PE');

      if (currentSearchFilter === 'stock') {
        return (symbol.endsWith('-EQ') || exchange === 'NSE' || exchange === 'BSE') && !isFO;
      }
      if (currentSearchFilter === 'fo') {
        return isFO;
      }
      if (currentSearchFilter === 'commodity') {
        return exchange === 'MCX';
      }
      return true;
    });

    if (filtered.length === 0) {
      suggestionsBox.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 30px 0; font-size: 14px; width: 100%;">No results found</div>';
      return;
    }

    filtered.forEach(item => {
      const parsed = parseDisplaySymbol(item.symbol, item.name, item.exchange);
      const cleanSym = parsed.baseSymbol;
      const subtitle = parsed.subtitle;
      const exchange = parsed.exchange;
      const typeText = parsed.type;
      
      // Determine instrument type text & badge styling
      let typeBadgeBg = 'rgba(59, 130, 246, 0.15)';
      let typeBadgeColor = '#60a5fa';
      
      if (typeText === 'CMD') {
        typeBadgeBg = 'rgba(20, 184, 166, 0.15)';
        typeBadgeColor = '#2dd4bf';
      } else if (typeText === 'EQ') {
        typeBadgeBg = 'rgba(99, 102, 241, 0.15)';
        typeBadgeColor = '#818cf8';
      } else if (typeText === 'FUT') {
        typeBadgeBg = 'rgba(245, 158, 11, 0.15)';
        typeBadgeColor = '#fbbf24';
      } else if (typeText === 'CE') {
        typeBadgeBg = 'rgba(16, 185, 129, 0.15)';
        typeBadgeColor = '#34d399';
      } else if (typeText === 'PE') {
        typeBadgeBg = 'rgba(239, 68, 68, 0.15)';
        typeBadgeColor = '#f87171';
      } else if (typeText === 'ETF') {
        typeBadgeBg = 'rgba(107, 114, 128, 0.15)';
        typeBadgeColor = '#9ca3af';
      }

      // Check if item is already in watchlist
      const isWatchlisted = watchlistSymbols.includes(item.symbol);
      const starClass = isWatchlisted ? 'fa-solid fa-star' : 'fa-regular fa-star';
      const starColor = isWatchlisted ? '#facc15' : 'var(--text-muted)';

      // Calculate price details
      const priceVal = item.price || 100.00;
      const prevCloseVal = item.prevClose || priceVal;
      const diff = priceVal - prevCloseVal;
      const pct = prevCloseVal > 0 ? (diff / prevCloseVal) * 100 : 0;
      
      let trendClass = 'text-green';
      let sign = '+';
      if (diff < 0) {
        trendClass = 'text-red';
        sign = '-';
      } else if (diff === 0) {
        trendClass = 'text-muted';
        sign = '';
      }

      const div = document.createElement('div');
      div.className = 'suggestion-item';
      div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; box-sizing: border-box; width: 100%; gap: 12px; flex-direction: row !important;';
      
      div.innerHTML = `
        <div class="sugg-left" style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="stock-sym" style="font-weight: 600; color: var(--text-primary); font-size: 14px; white-space: nowrap;">${cleanSym}</span>
            <span class="exch-badge" style="background: rgba(255,255,255,0.06); color: var(--text-secondary); font-size: 9px; padding: 1px 4px; border-radius: 4px; font-weight: 600;">${exchange}</span>
            <span class="type-badge" style="background: ${typeBadgeBg}; color: ${typeBadgeColor}; font-size: 9px; padding: 1px 4px; border-radius: 4px; font-weight: 600;">${typeText}</span>
          </div>
          <span class="stock-name" style="color: var(--text-secondary); opacity: 0.6; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; display: block;">${subtitle}</span>
        </div>
        
        <div class="sugg-right" style="display: flex; flex-direction: column; gap: 4px; text-align: right; align-items: flex-end; flex-shrink: 0;">
          <span id="sugg-price-${item.symbol}" style="font-weight: 600; color: var(--text-primary); font-size: 14px; font-family: var(--font-mono);">₹${priceVal.toFixed(2)}</span>
          <span id="sugg-trend-${item.symbol}" class="${trendClass}" style="font-size: 11px; font-weight: 500; font-family: var(--font-mono); white-space: nowrap;">${sign}${Math.abs(diff).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)</span>
        </div>

        <button class="sugg-star-btn" style="background: transparent; border: none; font-size: 16px; color: ${starColor}; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex-shrink: 0; margin-left: 2px;">
          <i class="${starClass}"></i>
        </button>
      `;

      // Click/Touch on row (excluding star button) opens stock details
      let touchStartX = 0;
      let touchStartY = 0;
      let touchMoved = false;
      
      div.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) {
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
        }
        touchMoved = false;
      }, { passive: true });

      div.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) {
          const moveX = e.touches[0].clientX;
          const moveY = e.touches[0].clientY;
          if (Math.abs(moveX - touchStartX) > 8 || Math.abs(moveY - touchStartY) > 8) {
            touchMoved = true;
          }
        }
      }, { passive: true });
      
      const handleRowClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.target.closest('.sugg-star-btn')) {
          toggleWatchlistSymbol(item.symbol);
        } else {
          searchInput.blur(); // Hide keyboard
          openStockDetails(item.symbol);
        }
      };

      div.addEventListener('click', handleRowClick);
      div.addEventListener('touchend', (e) => {
        if (!touchMoved) {
          handleRowClick(e);
        }
      });

      suggestionsBox.appendChild(div);
    });

    // Notify server of active search symbols to fetch their live prices
    const searchSymbols = currentSearchResults.map(m => m.symbol);
    if (searchSymbols.length > 0) {
      fetch(`${API_BASE}/watchlist/active-search?symbols=${encodeURIComponent(searchSymbols.join(','))}&t=${Date.now()}`)
        .catch(err => console.warn('Failed to sync search symbols:', err));
    }
  }
  window.renderSearchSuggestions = renderSearchSuggestions;

  // Watchlist Autocomplete Search (Debounced)
  searchInput.addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    const clearIcon = document.getElementById('watchlist-search-clear');
    
    if (clearIcon) {
      if (q.length > 0) clearIcon.classList.remove('hidden');
      else clearIcon.classList.add('hidden');
    }

    if (q.length < 2) {
      suggestionsBox.innerHTML = '';
      suggestionsBox.classList.add('hidden');
      currentSearchResults = [];
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/stocks/search?q=${encodeURIComponent(q)}&t=${Date.now()}`, { cache: 'no-store' });
      const matches = await response.json();
      currentSearchResults = matches;
      renderSearchSuggestions();
      hideWatchlistIndices();
      suggestionsBox.classList.remove('hidden');
    } catch (err) {
      console.error('Autocomplete error:', err);
    }
  }, 150));

  // Hide suggestions if clicking outside
  document.addEventListener('click', (e) => {
    if (isOpeningSearch) return; // Prevent layout-shift ghost clicks from closing search overlay
    if (!searchInput.contains(e.target) && !suggestionsBox.contains(e.target) && !e.target.closest('.search-filter-tab') && !e.target.closest('.sugg-star-btn') && !e.target.closest('#watchlist-search-clear')) {
      suggestionsBox.classList.add('hidden');
      showWatchlistIndices();
    }
  });
}

// Load initial config data
async function loadData() {
  try {
    const accResponse = await fetch(`${API_BASE}/accounts`);
    accounts = await accResponse.json();
    
    const mapResponse = await fetch(`${API_BASE}/mappings`);
    mappings = await mapResponse.json();

    try {
      const grpResponse = await fetch(`${API_BASE}/groups`);
      groups = await grpResponse.json();
    } catch (grpErr) {
      console.warn('Failed to fetch groups, fallback to empty:', grpErr.message);
      groups = [];
    }

    const wlResponse = await fetch(`${API_BASE}/watchlist?tab=${currentWatchlistTab}`);
    watchlistSymbols = await wlResponse.json();
    
    renderAccounts();
    renderGroups();
    renderOverviewStats();
    renderTopologyMap();
    renderQuickStatusList();
    renderMappingsTable();
    populateSimulatorDropdowns();
    populatePortfolioDropdown();
    renderWatchlistTable();
    fetchLogs();
  } catch (error) {
    console.error('Error loading config:', error);
  }
}

// Render Overview Statistics
function renderOverviewStats() {
  const totalAcc = accounts.length;
  const connectedAcc = accounts.filter(a => a.connected).length;
  const activeMappings = mappings.filter(m => m.active).length;

  document.getElementById('stat-masters').textContent = totalAcc;
  document.getElementById('stat-children').textContent = connectedAcc;
  document.getElementById('stat-linkages').textContent = activeMappings;
}

// Render connection quick status list
function renderQuickStatusList() {
  const container = document.getElementById('quick-status-list');
  container.innerHTML = '';

  if (accounts.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No accounts configured yet.</p></div>';
    return;
  }

  accounts.forEach(acc => {
    const brokerName = acc.broker === 'angel_one' ? 'Angel One' : (acc.broker === 'dhan' ? 'Dhan' : 'Motilal Oswal');
    const simTag = acc.isSimulated ? '(Simulated)' : '';
    const statusText = acc.connected ? 'CONNECTED' : 'OFFLINE';
    const statusClass = acc.connected ? 'connected' : 'disconnected';

    const div = document.createElement('div');
    div.className = 'status-item';
    div.innerHTML = `
      <div>
        <div class="status-item-name">${acc.name}</div>
        <div class="status-item-broker">${brokerName} ${simTag}</div>
      </div>
      <span class="badge ${statusClass}">${statusText}</span>
    `;
    container.appendChild(div);
  });
}

// Render Topology Node Map
function renderTopologyMap() {
  const container = document.getElementById('topology-map');
  if (!container) return;
  container.innerHTML = '';

  const activeMappings = mappings.filter(m => m.active);
  const masterAccounts = accounts.filter(a => a.type === 'master');
  const childAccounts = accounts.filter(a => a.type === 'child');

  if (activeMappings.length === 0 || masterAccounts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-sitemap"></i>
        <p>Define active mappings in the Mappings tab to display topology routing.</p>
      </div>
    `;
    return;
  }

  const graphDiv = document.createElement('div');
  graphDiv.className = 'topology-graph';

  // Left col: Masters
  const mastersCol = document.createElement('div');
  mastersCol.className = 'flex-column';
  mastersCol.style.gap = '20px';
  masterAccounts.forEach(master => {
    // Check if this master has active mappings
    const hasActiveLink = activeMappings.some(m => m.masterId === master.id);
    if (!hasActiveLink) return;

    const node = document.createElement('div');
    node.className = 'topo-node master';
    node.innerHTML = `
      <div class="node-name">${master.name}</div>
      <div class="node-broker">${master.broker === 'angel_one' ? 'Angel One' : (master.broker === 'dhan' ? 'Dhan' : 'Motilal Oswal')}</div>
      ${master.isSimulated ? '<span class="node-sim">Simulated</span>' : ''}
    `;
    mastersCol.appendChild(node);
  });

  // Middle col: Connection Lines
  const linesCol = document.createElement('div');
  linesCol.className = 'topo-connections';
  activeMappings.forEach(mapping => {
    const master = accounts.find(a => a.id === mapping.masterId);
    const child = accounts.find(a => a.id === mapping.childId);
    if (!master || !child) return;

    const line = document.createElement('div');
    line.className = 'topo-line';
    line.innerHTML = `<span class="line-label">${mapping.multiplier}x Multiplier</span>`;
    linesCol.appendChild(line);
  });

  // Right col: Children
  const childrenCol = document.createElement('div');
  childrenCol.className = 'flex-column';
  childrenCol.style.gap = '20px';
  activeMappings.forEach(mapping => {
    const child = childAccounts.find(a => a.id === mapping.childId);
    if (!child) return;

    const node = document.createElement('div');
    node.className = 'topo-node child';
    node.innerHTML = `
      <div class="node-name">${child.name}</div>
      <div class="node-broker">${child.broker === 'angel_one' ? 'Angel One' : (child.broker === 'dhan' ? 'Dhan' : 'Motilal Oswal')}</div>
      ${child.isSimulated ? '<span class="node-sim">Simulated</span>' : ''}
    `;
    childrenCol.appendChild(node);
  });

  graphDiv.appendChild(mastersCol);
  graphDiv.appendChild(linesCol);
  graphDiv.appendChild(childrenCol);
  container.appendChild(graphDiv);
}

// Render Accounts
function renderAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '';

  if (accounts.length === 0) {
    container.innerHTML = `
      <div class="card colspan-2" style="text-align: center; color: var(--text-secondary);">
        <i class="fa-solid fa-users-slash" style="font-size: 32px; margin-bottom: 12px; color: var(--text-muted);"></i>
        <p>No trading accounts configured. Click "Add Account" to get started.</p>
      </div>
    `;
    return;
  }

  accounts.forEach(acc => {
    const brokerName = acc.broker === 'angel_one' ? 'Angel One (SmartAPI)' : (acc.broker === 'dhan' ? 'Dhan (DhanHQ)' : 'Motilal Oswal (MOFSL)');
    const statusClass = acc.connected ? 'connected' : 'disconnected';
    const statusText = acc.connected ? 'Connected' : 'Offline';
    const connectionBtnText = acc.connected ? 'Reconnect' : 'Connect';

    const card = document.createElement('div');
    card.className = `card account-card`;
    
    let actionsHtml = '';
    if (acc.isSimulated) {
      actionsHtml = `
        <div class="account-card-actions" style="flex-wrap: wrap; gap: 8px;">
          <button class="btn btn-secondary btn-connect" data-id="${acc.id}" style="flex: 1 1 100%;">
            <i class="fa-solid fa-link"></i> ${connectionBtnText}
          </button>
          <button class="btn btn-secondary btn-recharge" data-id="${acc.id}" style="flex: 1 1 calc(50% - 4px);">
            <i class="fa-solid fa-wallet"></i> Recharge
          </button>
          <button class="btn btn-secondary btn-pnl-report" data-id="${acc.id}" style="flex: 1 1 calc(50% - 4px);">
            <i class="fa-solid fa-chart-line"></i> P&L Report
          </button>
          <button class="btn btn-secondary btn-edit" data-id="${acc.id}" style="flex: 1 1 calc(50% - 4px);">
            <i class="fa-solid fa-pen"></i> Edit
          </button>
          <button class="btn btn-danger btn-delete" data-id="${acc.id}" style="flex: 1 1 calc(50% - 4px);">
            <i class="fa-solid fa-trash-can"></i> Delete
          </button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="account-card-actions">
          <button class="btn btn-secondary btn-connect" data-id="${acc.id}">
            <i class="fa-solid fa-link"></i> ${connectionBtnText}
          </button>
          <button class="btn btn-secondary btn-edit" data-id="${acc.id}">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn btn-danger btn-delete" data-id="${acc.id}">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="account-card-header">
        <div class="account-title" style="display: flex; flex-direction: column; gap: 4px;">
          <h3 style="margin: 0; display: flex; align-items: center; gap: 8px;">
            ${acc.name}
            ${acc.isSimulated ? `<span class="badge" style="background: linear-gradient(135deg, #FF9900, #FF5E00); font-size: 10px; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold; text-transform: uppercase;">Paper</span>` : ''}
          </h3>
        </div>
        <div class="account-broker-logo">${brokerName}</div>
      </div>
      
      <div class="account-details">
        <div class="account-details-row">
          <span>Client / User ID:</span>
          <span>${acc.isSimulated ? 'SIMULATION' : (acc.clientCode || acc.userId || 'N/A').toUpperCase()}</span>
        </div>
        <div class="account-details-row">
          <span>Trading Balance:</span>
          ${acc.isSimulated
            ? `<span class="account-balance-val text-green" id="balance-${acc.id}" style="font-weight:600;">₹ ${(acc.balance !== undefined ? parseFloat(acc.balance) : 1000000.00).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
            : (acc.connected 
                ? `<span class="account-balance-val text-green" id="balance-${acc.id}" style="font-weight:600;"><i class="fa-solid fa-spinner fa-spin" style="font-size: 11px; margin-right: 4px;"></i>Fetching...</span>`
                : `<span class="account-balance-val" id="balance-${acc.id}" style="color: var(--text-muted); font-weight:500;">Offline (₹ --)</span>`
              )
          }
        </div>
        <div class="account-details-row">
          <span>Status:</span>
          <span class="text-${statusClass === 'connected' ? 'green' : 'red'}" style="font-weight:600;">
            ${statusText}
          </span>
        </div>
      </div>

      ${actionsHtml}
    `;

    // Connect button click
    card.querySelector('.btn-connect').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...';

      try {
        const response = await fetch(`${API_BASE}/connect/${acc.id}`, { method: 'POST' });
        const res = await response.json();
        if (res.success) {
          acc.connected = res.connected;
          loadData(); // Reload stats and items
        } else {
          alert('Failed to connect: please verify API credentials, secrets, or TOTP keys.');
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      } catch (err) {
        alert('Server connection error.');
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    });

    // Recharge button click
    const rechargeBtn = card.querySelector('.btn-recharge');
    if (rechargeBtn) {
      rechargeBtn.addEventListener('click', async () => {
        const amountStr = prompt(`Enter new balance amount for simulated account "${acc.name}":`, acc.balance || '1000000');
        if (amountStr === null) return; // Cancelled
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount < 0) {
          alert('Please enter a valid positive number.');
          return;
        }
        
        try {
          const response = await fetch(`${API_BASE}/accounts/${acc.id}/recharge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
          });
          const res = await response.json();
          if (res.success) {
            alert(`Balance successfully updated to ₹${parseFloat(res.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
            loadData();
          } else {
            alert('Failed to update balance: ' + (res.error || 'Unknown error'));
          }
        } catch (err) {
          alert('Network error while updating balance.');
        }
      });
    }

    // P&L Report button click
    const pnlReportBtn = card.querySelector('.btn-pnl-report');
    if (pnlReportBtn) {
      pnlReportBtn.addEventListener('click', () => {
        openPnlReportModal(acc.id);
      });
    }

    // Edit button click
    card.querySelector('.btn-edit').addEventListener('click', () => {
      editAccount(acc);
    });

    // Delete button click
    card.querySelector('.btn-delete').addEventListener('click', async () => {
      if (confirm(`Are you sure you want to delete ${acc.name}? All active copy settings mapping this account will also be removed.`)) {
        await fetch(`${API_BASE}/accounts/${acc.id}`, { method: 'DELETE' });
        loadData();
      }
    });

    container.appendChild(card);

    // Fetch balance asynchronously if connected
    if (acc.connected) {
      fetch(`${API_BASE}/portfolio/${acc.id}`)
        .then(res => res.json())
        .then(data => {
          const balanceEl = document.getElementById(`balance-${acc.id}`);
          if (balanceEl) {
            if (data.funds && data.funds.availableCash !== undefined) {
              balanceEl.textContent = `₹ ${data.funds.availableCash.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            } else {
              balanceEl.textContent = '₹ --';
              balanceEl.style.color = 'var(--text-muted)';
            }
          }
        })
        .catch(err => {
          console.error('Error fetching balance for account:', acc.id, err);
          const balanceEl = document.getElementById(`balance-${acc.id}`);
          if (balanceEl) {
            balanceEl.textContent = 'Error';
            balanceEl.style.color = 'var(--red)';
          }
        });
    }
  });
}

// Account Form helpers
function showAddAccountForm() {
  document.getElementById('account-form-container').classList.remove('hidden');
  document.getElementById('form-title').textContent = 'Add New Trading Account';
  document.getElementById('account-form').reset();
  document.getElementById('acc-id').value = '';
  document.getElementById('acc-proxyurl').style.display = 'none';
  document.getElementById('acc-proxyurl').required = false;
  document.getElementById('acc-is-simulated').checked = false;
  updateSimulationFieldsVisibility();
}

function hideAccountForm() {
  document.getElementById('account-form-container').classList.add('hidden');
}

function updateSimulationFieldsVisibility() {
  const isSimulated = document.getElementById('acc-is-simulated').checked;
  const simBalanceGroup = document.getElementById('sim-balance-group');
  const liveFields = document.getElementById('live-credentials-fields');
  const broker = document.getElementById('acc-broker').value;

  if (isSimulated) {
    simBalanceGroup.classList.remove('hidden');
    liveFields.classList.add('hidden');
    
    // Disable required attributes for live fields
    document.getElementById('acc-clientcode').required = false;
    document.getElementById('acc-password-ao').required = false;
    document.getElementById('acc-userid').required = false;
    document.getElementById('acc-password-mo').required = false;
    document.getElementById('acc-dhan-clientid').required = false;
    document.getElementById('acc-dhan-accesstoken').required = false;
    document.getElementById('acc-proxyurl').required = false;
  } else {
    simBalanceGroup.classList.add('hidden');
    liveFields.classList.remove('hidden');
    // Re-apply standard broker fields validation
    toggleBrokerFields(broker);
  }
}

function toggleBrokerFields(broker) {
  const isSimulated = document.getElementById('acc-is-simulated').checked;
  if (broker === 'angel_one') {
    document.querySelector('.angel_one-fields').classList.remove('hidden');
    document.querySelector('.motilal-fields').classList.add('hidden');
    document.querySelector('.dhan-fields').classList.add('hidden');
    document.getElementById('acc-clientcode').required = !isSimulated;
    document.getElementById('acc-password-ao').required = !isSimulated;
    document.getElementById('acc-userid').required = false;
    document.getElementById('acc-password-mo').required = false;
    document.getElementById('acc-dhan-clientid').required = false;
    document.getElementById('acc-dhan-accesstoken').required = false;
  } else if (broker === 'motilal') {
    document.querySelector('.angel_one-fields').classList.add('hidden');
    document.querySelector('.motilal-fields').classList.remove('hidden');
    document.querySelector('.dhan-fields').classList.add('hidden');
    document.getElementById('acc-clientcode').required = false;
    document.getElementById('acc-password-ao').required = false;
    document.getElementById('acc-userid').required = !isSimulated;
    document.getElementById('acc-password-mo').required = !isSimulated;
    document.getElementById('acc-dhan-clientid').required = false;
    document.getElementById('acc-dhan-accesstoken').required = false;
  } else if (broker === 'dhan') {
    document.querySelector('.angel_one-fields').classList.add('hidden');
    document.querySelector('.motilal-fields').classList.add('hidden');
    document.querySelector('.dhan-fields').classList.remove('hidden');
    document.getElementById('acc-clientcode').required = false;
    document.getElementById('acc-password-ao').required = false;
    document.getElementById('acc-userid').required = false;
    document.getElementById('acc-password-mo').required = false;
    document.getElementById('acc-dhan-clientid').required = !isSimulated;
    document.getElementById('acc-dhan-accesstoken').required = !isSimulated;
  }
}

function editAccount(acc) {
  document.getElementById('account-form-container').classList.remove('hidden');
  document.getElementById('form-title').textContent = `Edit Account: ${acc.name}`;
  document.getElementById('acc-id').value = acc.id;
  document.getElementById('acc-name').value = acc.name;
  document.getElementById('acc-role').value = acc.type;
  document.getElementById('acc-broker').value = acc.broker;
  document.getElementById('acc-apikey').value = acc.apiKey || '';
  document.getElementById('acc-totpsecret').value = acc.totpSecret || '';
  
  // Simulation fields population
  const isSim = !!acc.isSimulated;
  document.getElementById('acc-is-simulated').checked = isSim;
  if (isSim) {
    document.getElementById('acc-sim-balance').value = acc.balance !== undefined ? acc.balance : 1000000;
  }
  updateSimulationFieldsVisibility();

  // Connection Routing population
  const proxyVal = acc.proxyUrl || '';
  const proxyInput = document.getElementById('acc-proxyurl');
  if (proxyVal === 'vps') {
    document.querySelector('input[name="conn-route-type"][value="vps"]').checked = true;
    proxyInput.value = '';
    proxyInput.style.display = 'none';
    proxyInput.required = false;
  } else if (proxyVal !== '') {
    document.querySelector('input[name="conn-route-type"][value="custom"]').checked = true;
    proxyInput.value = proxyVal;
    proxyInput.style.display = 'block';
    proxyInput.required = true;
  } else {
    document.querySelector('input[name="conn-route-type"][value="direct"]').checked = true;
    proxyInput.value = '';
    proxyInput.style.display = 'none';
    proxyInput.required = false;
  }

  if (!isSim) {
    toggleBrokerFields(acc.broker);

    if (acc.broker === 'angel_one') {
      document.getElementById('acc-clientcode').value = acc.clientCode || '';
      document.getElementById('acc-password-ao').value = acc.password || '';
    } else if (acc.broker === 'motilal') {
      document.getElementById('acc-userid').value = acc.userId || '';
      document.getElementById('acc-password-mo').value = acc.password || '';
      document.getElementById('acc-2fa').value = acc.twoFactor || '';
      document.getElementById('acc-apisecret').value = acc.apiSecret || '';
    } else if (acc.broker === 'dhan') {
      document.getElementById('acc-dhan-clientid').value = acc.clientCode || '';
      document.getElementById('acc-dhan-accesstoken').value = acc.password || '';
    }
  } else {
    // Clear live fields in UI for simulated edit
    document.getElementById('acc-clientcode').value = '';
    document.getElementById('acc-password-ao').value = '';
    document.getElementById('acc-userid').value = '';
    document.getElementById('acc-password-mo').value = '';
    document.getElementById('acc-2fa').value = '';
    document.getElementById('acc-apisecret').value = '';
    document.getElementById('acc-dhan-clientid').value = '';
    document.getElementById('acc-dhan-accesstoken').value = '';
  }
  
  document.getElementById('account-form-container').scrollIntoView({ behavior: 'smooth' });
}

async function handleAccountSubmit(e) {
  e.preventDefault();
  
  const broker = document.getElementById('acc-broker').value;
  const isSimulated = document.getElementById('acc-is-simulated').checked;

  const inputName = document.getElementById('acc-name').value.trim();
  let clientCodeVal = '';
  if (!isSimulated) {
    if (broker === 'angel_one') {
      clientCodeVal = document.getElementById('acc-clientcode').value.toUpperCase();
    } else if (broker === 'motilal') {
      clientCodeVal = document.getElementById('acc-userid').value.toUpperCase();
    } else if (broker === 'dhan') {
      clientCodeVal = document.getElementById('acc-dhan-clientid').value;
    }
  }
  const displayName = inputName || (isSimulated ? `Simulated ${broker === 'angel_one' ? 'Angel One' : (broker === 'dhan' ? 'Dhan' : 'Motilal Oswal')}` : clientCodeVal) || 'New Account';

  const routeType = document.querySelector('input[name="conn-route-type"]:checked').value;
  let finalProxyUrl = '';
  if (!isSimulated) {
    if (routeType === 'vps') {
      finalProxyUrl = 'vps';
    } else if (routeType === 'custom') {
      finalProxyUrl = document.getElementById('acc-proxyurl').value.trim();
    }
  }

  const payload = {
    id: document.getElementById('acc-id').value || undefined,
    name: displayName,
    type: document.getElementById('acc-role').value,
    broker,
    isSimulated,
    apiKey: isSimulated ? '' : document.getElementById('acc-apikey').value,
    totpSecret: isSimulated ? '' : document.getElementById('acc-totpsecret').value,
    proxyUrl: finalProxyUrl
  };

  if (isSimulated) {
    payload.balance = parseFloat(document.getElementById('acc-sim-balance').value) || 1000000;
  } else {
    if (broker === 'angel_one') {
      payload.clientCode = document.getElementById('acc-clientcode').value.toUpperCase();
      payload.password = document.getElementById('acc-password-ao').value;
    } else if (broker === 'motilal') {
      payload.userId = document.getElementById('acc-userid').value.toUpperCase();
      payload.password = document.getElementById('acc-password-mo').value;
      payload.twoFactor = document.getElementById('acc-2fa').value.toUpperCase();
      payload.apiSecret = document.getElementById('acc-apisecret').value;
    } else if (broker === 'dhan') {
      payload.clientCode = document.getElementById('acc-dhan-clientid').value;
      payload.password = document.getElementById('acc-dhan-accesstoken').value;
    }
  }

  try {
    const response = await fetch(`${API_BASE}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      hideAccountForm();
      loadData();
    } else {
      alert('Error saving account configuration.');
    }
  } catch (err) {
    alert('Network error while saving account.');
  }
}

async function openPnlReportModal(accountId) {
  try {
    const response = await fetch(`${API_BASE}/accounts/${accountId}/pnl-report`);
    if (!response.ok) throw new Error('Failed to fetch P&L report');
    const trades = await response.json();
    
    const tbody = document.getElementById('pnl-report-table-body');
    tbody.innerHTML = '';
    
    let totalPnl = 0;
    
    if (trades.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px 0;">
            No closed trades found for this simulated account.
          </td>
        </tr>
      `;
    } else {
      trades.forEach(trade => {
        totalPnl += trade.pnl;
        const pnlClass = trade.pnl >= 0 ? 'text-green' : 'text-red';
        const pnlSign = trade.pnl >= 0 ? '+' : '';
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="padding: 8px; font-size: 12px; color: var(--text-muted);">${trade.timestamp}</td>
          <td style="padding: 8px; font-weight: 600;">${trade.tradingsymbol}</td>
          <td style="padding: 8px; font-size: 12px;"><span class="badge ${trade.producttype === 'INTRADAY' ? 'badge-intraday' : 'badge-cnc'}" style="background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border-color);">${trade.producttype}</span></td>
          <td style="padding: 8px; text-align: right;">${trade.quantity}</td>
          <td style="padding: 8px; text-align: right;">₹${parseFloat(trade.buyPrice).toFixed(2)}</td>
          <td style="padding: 8px; text-align: right;">₹${parseFloat(trade.sellPrice).toFixed(2)}</td>
          <td style="padding: 8px; text-align: right; font-weight: bold;" class="${pnlClass}">${pnlSign}₹${trade.pnl.toFixed(2)}</td>
        `;
        tbody.appendChild(tr);
      });
    }
    
    const totalEl = document.getElementById('pnl-report-total');
    totalEl.textContent = `${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(2)}`;
    totalEl.className = totalPnl >= 0 ? 'text-green' : 'text-red';
    
    document.getElementById('pnl-report-count').textContent = trades.length.toString();
    
    document.getElementById('pnl-report-modal').classList.remove('hidden');
  } catch (err) {
    alert('Error fetching P&L report: ' + err.message);
  }
}

function closePnlReportModal() {
  document.getElementById('pnl-report-modal').classList.add('hidden');
}

window.openPnlReportModal = openPnlReportModal;
window.closePnlReportModal = closePnlReportModal;

// Render Mappings Table
function renderMappingsTable() {
  const container = document.getElementById('mappings-list');
  container.innerHTML = '';

  const masterOptions = accounts;
  const childOptions = accounts;

  if (mappings.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px 0;">
          No copy mappings configured. Add a row to define linked accounts.
        </td>
      </tr>
    `;
    return;
  }

  mappings.forEach((mapping, index) => {
    const tr = document.createElement('tr');
    
    // Master Selection
    let masterSelect = `<select class="table-select mapping-master" data-index="${index}">`;
    masterOptions.forEach(m => {
      masterSelect += `<option value="${m.id}" ${mapping.masterId === m.id ? 'selected' : ''}>${m.name}</option>`;
    });
    masterSelect += `</select>`;

    // Child Selection
    let childSelect = `<select class="table-select mapping-child" data-index="${index}">`;
    childOptions.forEach(c => {
      childSelect += `<option value="${c.id}" ${mapping.childId === c.id ? 'selected' : ''}>${c.name}</option>`;
    });
    childSelect += `</select>`;

    tr.innerHTML = `
      <td>${masterSelect}</td>
      <td>${childSelect}</td>
      <td>
        <input type="number" class="table-input mapping-multiplier" step="0.1" min="0.1" value="${mapping.multiplier}" data-index="${index}">
      </td>
      <td>
        <label class="switch">
          <input type="checkbox" class="mapping-active" ${mapping.active ? 'checked' : ''} data-index="${index}">
          <span class="slider"></span>
        </label>
      </td>
      <td>
        <button class="btn btn-icon btn-delete-mapping" data-index="${index}" title="Remove linkage">
          <i class="fa-solid fa-trash-can" style="color: var(--red);"></i>
        </button>
      </td>
    `;

    tr.querySelector('.btn-delete-mapping').addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-index'));
      mappings.splice(idx, 1);
      renderMappingsTable();
    });

    container.appendChild(tr);
  });
}

function addMappingRow() {
  if (accounts.length === 0) {
    alert('Please configure at least one account before creating mappings.');
    return;
  }

  mappings.push({
    masterId: accounts[0].id,
    childId: accounts[1] ? accounts[1].id : accounts[0].id,
    multiplier: 1.0,
    active: true
  });

  renderMappingsTable();
}

async function saveMappings() {
  // Read inputs from DOM to update mappings list
  const rows = document.querySelectorAll('#mappings-list tr');
  const updatedMappings = [];

  rows.forEach(row => {
    const masterSelect = row.querySelector('.mapping-master');
    const childSelect = row.querySelector('.mapping-child');
    const multiplierInput = row.querySelector('.mapping-multiplier');
    const activeCheck = row.querySelector('.mapping-active');

    if (masterSelect && childSelect && multiplierInput && activeCheck) {
      updatedMappings.push({
        masterId: masterSelect.value,
        childId: childSelect.value,
        multiplier: parseFloat(multiplierInput.value) || 1.0,
        active: activeCheck.checked
      });
    }
  });

  try {
    const response = await fetch(`${API_BASE}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedMappings)
    });

    if (response.ok) {
      mappings = updatedMappings;
      renderOverviewStats();
      renderTopologyMap();
      alert('Mappings saved successfully!');
    } else {
      alert('Error saving mappings to server.');
    }
  } catch (err) {
    alert('Connection failure saving mappings.');
  }
}

// ================= GROUPS MANAGEMENT =================

window.renderGroups = function() {
  const container = document.getElementById('groups-list-container');
  if (!container) return;
  container.innerHTML = '';

  if (groups.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: span 3; padding: 20px 0;">
        <i class="fa-solid fa-folder-open" style="font-size: 32px; color: var(--text-muted); margin-bottom: 8px;"></i>
        <p style="font-size: 13px; color: var(--text-muted);">No groups configured. Click "Create Group" to configure a replication group.</p>
      </div>
    `;
    return;
  }

  groups.forEach(g => {
    const master = accounts.find(a => a.id === g.masterId);
    let masterName = master ? master.name : `Unknown Master (${g.masterId})`;
    if (master) {
      const broker = master.broker === 'angel_one' ? 'Angel' : (master.broker === 'dhan' ? 'Dhan' : 'Motilal');
      masterName = `${masterName} (${broker})`;
    }

    let childrenHtml = '';
    g.children.forEach(c => {
      const child = accounts.find(a => a.id === c.childId);
      let childName = child ? child.name : `Unknown (${c.childId})`;
      if (child) {
        const broker = child.broker === 'angel_one' ? 'Angel' : (child.broker === 'dhan' ? 'Dhan' : 'Motilal');
        childName = `${childName} (${broker})`;
      }
      const inactiveStyle = c.active === false ? 'style="color: var(--text-muted); text-decoration: line-through;"' : '';
      childrenHtml += `<li ${inactiveStyle}>${childName} <strong style="color: var(--cyan);">${c.multiplier}x</strong></li>`;
    });

    if (g.children.length === 0) {
      childrenHtml = '<span style="color: var(--text-muted); font-size: 12px;">No child accounts mapped</span>';
    } else {
      childrenHtml = `<ul style="margin: 0; padding-left: 18px; font-size: 13px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px;">${childrenHtml}</ul>`;
    }

    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'padding: 20px; display: flex; flex-direction: column; gap: 14px; position: relative; transition: var(--transition);';
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div>
          <h3 style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 0;">${g.name}</h3>
          <span style="font-size: 12px; color: var(--text-muted); display: block; margin-top: 4px;">Master: <strong style="color: var(--primary); font-size: 13px; font-weight: 600;">${masterName}</strong></span>
        </div>
        <label class="switch">
          <input type="checkbox" onchange="toggleGroupActive('${g.id}', this.checked)" ${g.active ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
      
      <div style="border-top: 1px solid var(--border-color); padding-top: 12px;">
        <span style="font-size: 11px; color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">Child Account</span>
        ${childrenHtml}
      </div>
      
      <div style="display: flex; gap: 8px; margin-top: auto; border-top: 1px solid var(--border-color); padding-top: 12px;">
        <button class="btn btn-secondary flex-1" onclick="openEditGroupModal('${g.id}')" style="padding: 8px; border-radius: 8px; font-size: 12px; display: flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid rgba(13, 148, 136, 0.2); background: rgba(13, 148, 136, 0.04); color: var(--primary); font-weight: 600; cursor: pointer; transition: var(--transition);"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn btn-secondary" onclick="deleteGroup('${g.id}')" style="padding: 8px 12px; border-radius: 8px; font-size: 12px; border: 1px solid rgba(244, 63, 94, 0.2); background: rgba(244, 63, 94, 0.04); color: var(--red); cursor: pointer; transition: var(--transition);"><i class="fa-solid fa-trash-can"></i></button>
      </div>
    `;
    container.appendChild(card);
  });
};

window.openCreateGroupModal = function() {
  pushModalHistory('group-modal');
  document.getElementById('group-id').value = '';
  document.getElementById('group-name').value = '';
  document.getElementById('group-modal-title').innerHTML = '<i class="fa-solid fa-folder-plus" style="color: var(--primary);"></i> Create Copy Group';
  
  populateGroupMasterSelect('');
  populateGroupChildrenList([]);
  
  document.getElementById('group-modal').classList.remove('hidden');
};

window.openEditGroupModal = function(groupId) {
  pushModalHistory('group-modal');
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  document.getElementById('group-id').value = group.id;
  document.getElementById('group-name').value = group.name;
  document.getElementById('group-modal-title').innerHTML = '<i class="fa-solid fa-folder-open" style="color: var(--primary);"></i> Edit Copy Group';
  
  populateGroupMasterSelect(group.masterId);
  populateGroupChildrenList(group.children);
  
  document.getElementById('group-modal').classList.remove('hidden');
};

window.closeGroupModal = function(preventPop) {
  document.getElementById('group-modal').classList.add('hidden');
  if (!preventPop) {
    popModalHistory('group-modal');
  }
};

function populateGroupMasterSelect(selectedMasterId) {
  const select = document.getElementById('group-master');
  select.innerHTML = '';
  
  const connectedMasters = accounts.filter(acc => acc.connected === true);
  connectedMasters.forEach(acc => {
    const opt = document.createElement('option');
    opt.value = acc.id;
    const brokerPretty = acc.broker === 'angel_one' ? 'Angel' : (acc.broker === 'dhan' ? 'Dhan' : 'Motilal');
    opt.textContent = `${acc.name} [${brokerPretty}]`;
    if (acc.id === selectedMasterId) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
  
  if (connectedMasters.length === 0) {
    select.innerHTML = '<option value="">No connected accounts available</option>';
  }
}

function populateGroupChildrenList(selectedChildren) {
  const container = document.getElementById('group-children-list');
  container.innerHTML = '';
  
  const masterSelect = document.getElementById('group-master');
  const activeMasterId = masterSelect ? masterSelect.value : '';
  
  if (masterSelect && !masterSelect.onchange) {
    masterSelect.onchange = () => {
      const currentConfigured = [];
      const rows = container.querySelectorAll('.group-child-row');
      rows.forEach(row => {
        const checkbox = row.querySelector('.child-check');
        const multiplier = row.querySelector('.child-multiplier');
        if (checkbox && checkbox.checked) {
          currentConfigured.push({
            childId: checkbox.value,
            multiplier: parseFloat(multiplier.value) || 1.0,
            active: true
          });
        }
      });
      populateGroupChildrenList(currentConfigured);
    };
  }

  const connectedChildren = accounts.filter(acc => acc.connected === true);
  connectedChildren.forEach(acc => {
    if (acc.id === activeMasterId) return; // Prevent mapping to itself
    
    const existing = selectedChildren.find(c => c.childId === acc.id);
    const checked = existing ? 'checked' : '';
    const multiplier = existing ? existing.multiplier : 1.0;
    
    const row = document.createElement('div');
    row.className = 'group-child-row';
    row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; background: var(--bg-primary); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color); min-width: 0;';
    row.innerHTML = `
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; min-width: 0; font-size: 13px; user-select: none; color: var(--text-primary); margin: 0;">
        <input type="checkbox" class="child-check" value="${acc.id}" ${checked} style="cursor: pointer; width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--primary);">
        <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;">
          <div style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary);">${acc.name}</div>
          <div style="font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${acc.broker === 'angel_one' ? 'Angel' : (acc.broker === 'dhan' ? 'Dhan' : 'Motilal')}</div>
        </div>
      </label>
      <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
        <span style="font-size: 11px; color: var(--text-muted); font-weight: 500;">x</span>
        <input type="number" class="child-multiplier" step="0.1" min="0.1" value="${multiplier}" style="width: 48px; padding: 5px 3px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-primary); text-align: center; font-size: 12px; font-family: var(--font-mono); outline: none;">
      </div>
    `;
    container.appendChild(row);
  });
  
  if (accounts.length <= 1) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 10px 0;">Add at least 2 accounts to configure groups</div>';
  }
}

window.saveGroup = async function() {
  const nameInput = document.getElementById('group-name');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Please enter a group name.');
    return;
  }
  
  const masterId = document.getElementById('group-master').value;
  if (!masterId) {
    alert('Please select a master account.');
    return;
  }
  
  const children = [];
  const rows = document.querySelectorAll('#group-children-list .group-child-row');
  rows.forEach(row => {
    const check = row.querySelector('.child-check');
    const multiplier = row.querySelector('.child-multiplier');
    if (check && check.checked) {
      children.push({
        childId: check.value,
        multiplier: parseFloat(multiplier.value) || 1.0,
        active: true
      });
    }
  });
  
  if (children.length === 0) {
    alert('Please select at least one child account.');
    return;
  }
  
  const groupId = document.getElementById('group-id').value;
  const isEdit = groupId !== '';
  
  const groupObj = {
    id: isEdit ? groupId : 'grp_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now(),
    name,
    masterId,
    active: isEdit ? (groups.find(g => g.id === groupId)?.active ?? true) : true,
    children
  };
  
  let updatedGroups = [...groups];
  if (isEdit) {
    const idx = updatedGroups.findIndex(g => g.id === groupId);
    if (idx !== -1) {
      updatedGroups[idx] = groupObj;
    }
  } else {
    updatedGroups.push(groupObj);
  }
  
  try {
    const response = await fetch(`${API_BASE}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedGroups)
    });
    
    if (response.ok) {
      const data = await response.json();
      groups = updatedGroups;
      mappings = data.mappings || [];
      
      renderGroups();
      renderOverviewStats();
      renderTopologyMap();
      renderMappingsTable();
      closeGroupModal();
      showNotification(isEdit ? 'Group updated successfully!' : 'Group created successfully!', 'success');
    } else {
      alert('Failed to save group configuration.');
    }
  } catch (err) {
    alert('Network error saving group.');
  }
};

window.deleteGroup = async function(groupId) {
  if (!confirm('Are you sure you want to delete this group?')) return;
  
  const updatedGroups = groups.filter(g => g.id !== groupId);
  
  try {
    const response = await fetch(`${API_BASE}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedGroups)
    });
    
    if (response.ok) {
      const data = await response.json();
      groups = updatedGroups;
      mappings = data.mappings || [];
      
      renderGroups();
      renderOverviewStats();
      renderTopologyMap();
      renderMappingsTable();
      showNotification('Group deleted successfully.', 'success');
    } else {
      alert('Failed to delete group.');
    }
  } catch (err) {
    alert('Network error deleting group.');
  }
};

window.toggleGroupActive = async function(groupId, isActive) {
  const updatedGroups = groups.map(g => {
    if (g.id === groupId) {
      return { ...g, active: isActive };
    }
    return g;
  });
  
  try {
    const response = await fetch(`${API_BASE}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedGroups)
    });
    
    if (response.ok) {
      const data = await response.json();
      groups = updatedGroups;
      mappings = data.mappings || [];
      
      renderGroups();
      renderOverviewStats();
      renderTopologyMap();
      renderMappingsTable();
      showNotification(isActive ? 'Group activated.' : 'Group deactivated.', 'success');
    } else {
      alert('Failed to toggle group status.');
    }
  } catch (err) {
    console.error('Network error toggling group active state:', err);
  }
};

// Simulator Tab Actions
function populateSimulatorDropdowns() {
  const select = document.getElementById('sim-master');
  select.innerHTML = '';

  const connectedMasters = accounts.filter(acc => acc.connected === true);
  if (connectedMasters.length === 0) {
    select.innerHTML = '<option value="">No connected accounts available</option>';
    return;
  }

  connectedMasters.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const brokerPretty = m.broker === 'angel_one' ? 'Angel' : (m.broker === 'dhan' ? 'Dhan' : 'Motilal');
    opt.textContent = `${m.name} [${brokerPretty}]`;
    select.appendChild(opt);
  });
}

async function handleSimulatorSubmit(e) {
  e.preventDefault();

  const masterId = document.getElementById('sim-master').value;
  if (!masterId) {
    alert('Please select a Master account to execute order.');
    return;
  }

  const btn = document.getElementById('btn-execute-simulation');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Executing copy loop...';

  const transactiontype = document.querySelector('input[name="sim-side"]:checked').value;
  const ordertype = document.getElementById('sim-type').value;

  const payload = {
    masterId,
    exchange: document.getElementById('sim-exchange').value,
    tradingsymbol: document.getElementById('sim-symbol').value,
    symboltoken: document.getElementById('sim-token').value,
    producttype: document.getElementById('sim-product').value,
    transactiontype,
    quantity: parseInt(document.getElementById('sim-qty').value),
    ordertype,
    price: ordertype === 'LIMIT' ? parseFloat(document.getElementById('sim-price').value) : 0
  };

  try {
    const response = await fetch(`${API_BASE}/execute-trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      if (data.success === false) {
        const errorMsg = data.error || (data.masterResponse && data.masterResponse.message) || 'Unknown broker error';
        alert(`Order Placement Failed: ${errorMsg}`);
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Execute Order & Copy';
        return;
      }
      // Small timeout to let operations run before refreshing logs
      setTimeout(() => {
        fetchLogs();
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Execute Order & Copy';
        // Increment copiers counter for UI flavor
        const copiedCounter = document.getElementById('stat-copied-trades');
        const activeLinkages = mappings.filter(m => m.masterId === masterId && m.active).length;
        copiedCounter.textContent = parseInt(copiedCounter.textContent) + 1 + activeLinkages;
      }, 500);
    } else {
      const err = await response.json();
      alert(`Execution Error: ${err.error || err.message || 'Server error'}`);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Execute Order & Copy';
    }
  } catch (err) {
    alert('Execution request failed.');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Execute Order & Copy';
  }
}

// Log Consol Streaming
async function fetchLogs() {
  try {
    const response = await fetch(`${API_BASE}/logs`);
    const logs = await response.json();
    renderLogs(logs);
  } catch (err) {
    console.error('Error fetching logs:', err);
  }
}

function renderLogs(logs) {
  const containers = [
    document.getElementById('console-logs'),
    document.getElementById('modal-logs-container')
  ].filter(c => c !== null);

  containers.forEach(container => {
    // Save scroll status
    const isScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 30;
    
    container.innerHTML = '';
    
    if (logs.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); text-align:center; padding: 20px 0;">Console empty. Place a trade or connect accounts to see logs.</div>';
      return;
    }

    logs.forEach(log => {
      const div = document.createElement('div');
      div.className = 'console-line';
      
      const timeStr = new Date(log.timestamp).toLocaleTimeString();
      const tagClass = log.type; // success, error, info, engine, api-request
      
      let detailsHtml = '';
      if (log.details) {
        detailsHtml = `<pre class="console-details">${JSON.stringify(log.details, null, 2)}</pre>`;
      }

      div.innerHTML = `
        <span class="console-time">[${timeStr}]</span>
        <span class="console-tag ${tagClass}">${log.type}</span>
        <span style="font-weight: 500;">${log.accountName ? `[${log.accountName}] ` : ''}${log.message}</span>
        ${detailsHtml}
      `;
      container.appendChild(div);
    });

    // Keep scroll focused at bottom if it was scrolled to bottom
    if (isScrolledToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  });
}

window.clearLogs = async function() {
  if (confirm('Clear audit console history?')) {
    await fetch(`${API_BASE}/logs/clear`, { method: 'POST' });
    fetchLogs();
  }
}

window.openLogsModal = function() {
  pushModalHistory('logs-modal');
  document.getElementById('logs-modal').classList.remove('hidden');
  fetchLogs();
}

window.closeLogsModal = function(preventPop) {
  document.getElementById('logs-modal').classList.add('hidden');
  if (!preventPop) {
    popModalHistory('logs-modal');
  }
}

function startLogPolling() {
  if (logPoller) clearInterval(logPoller);
  logPoller = setInterval(fetchLogs, 2000);
}

// Portfolio View Tab
function populatePortfolioDropdown() {
  const select = document.getElementById('portfolio-account');
  const orderSelect = document.getElementById('orders-account-select');
  const currentSelection = select ? select.value : (orderSelect ? orderSelect.value : '');

  const connectedAccounts = accounts.filter(acc => acc.connected === true);

  if (select) {
    select.innerHTML = '';
    if (connectedAccounts.length === 0) {
      select.innerHTML = '<option value="">No connected accounts available</option>';
    } else {
      connectedAccounts.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        const brokerPretty = acc.broker === 'angel_one' ? 'Angel' : (acc.broker === 'dhan' ? 'Dhan' : 'Motilal');
        opt.textContent = `${acc.name} [${brokerPretty}]`;
        if (acc.id === currentSelection) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }
  }

  if (orderSelect) {
    orderSelect.innerHTML = '';
    if (connectedAccounts.length === 0) {
      orderSelect.innerHTML = '<option value="">No connected accounts available</option>';
    } else {
      connectedAccounts.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        const brokerPretty = acc.broker === 'angel_one' ? 'Angel' : (acc.broker === 'dhan' ? 'Dhan' : 'Motilal');
        opt.textContent = `${acc.name} [${brokerPretty}]`;
        if (acc.id === currentSelection) {
          opt.selected = true;
        }
        orderSelect.appendChild(opt);
      });
    }
  }
}

function calculatePositionPnl(pos) {
  const qty = pos.netqty !== undefined ? safeParseFloat(pos.netqty) : (pos.buyquantity !== undefined && pos.sellquantity !== undefined ? safeParseFloat(pos.buyquantity) - safeParseFloat(pos.sellquantity) : safeParseFloat(pos.buyquantity || 0));
  const avgPrice = getPositionAvgPrice(pos);
  const ltp = safeParseFloat(pos.ltp || pos.LTP || 0);
  
  // 1. Dhan style realized + unrealized
  if (pos.realizedProfit !== undefined || pos.unrealizedProfit !== undefined) {
    return safeParseFloat(pos.realizedProfit || 0) + safeParseFloat(pos.unrealizedProfit || 0);
  }
  
  // 2. Angel One style realized + unrealized
  if (pos.realisedpnl !== undefined || pos.unrealisedpnl !== undefined) {
    return safeParseFloat(pos.realisedpnl || 0) + safeParseFloat(pos.unrealisedpnl || 0);
  }
  
  // 3. Other generic realized/unrealised fields
  if (pos.realised !== undefined || pos.unrealised !== undefined) {
    return safeParseFloat(pos.realised || 0) + safeParseFloat(pos.unrealised || 0);
  }
  
  // 4. Net value / MTM / P&L direct field if it is non-zero
  if (pos.pnl !== undefined && pos.pnl !== null && safeParseFloat(pos.pnl) !== 0) {
    return safeParseFloat(pos.pnl);
  }
  if (pos.netvalue !== undefined && pos.netvalue !== null && safeParseFloat(pos.netvalue) !== 0) {
    return safeParseFloat(pos.netvalue);
  }
  if (pos.marktomarket !== undefined && pos.marktomarket !== null && safeParseFloat(pos.marktomarket) !== 0) {
    return safeParseFloat(pos.marktomarket);
  }
  
  // 5. Fallback for closed positions (qty === 0)
  if (qty === 0) {
    if (pos.realisedpnl !== undefined) return safeParseFloat(pos.realisedpnl);
    if (pos.realizedProfit !== undefined) return safeParseFloat(pos.realizedProfit);
    if (pos.realised !== undefined) return safeParseFloat(pos.realised);
    if (pos.pnl !== undefined) return safeParseFloat(pos.pnl);
    if (pos.netvalue !== undefined) return safeParseFloat(pos.netvalue);
    if (pos.marktomarket !== undefined) return safeParseFloat(pos.marktomarket);
    
    if (pos.buyamount !== undefined && pos.sellamount !== undefined) {
      return safeParseFloat(pos.sellamount) - safeParseFloat(pos.buyamount);
    }
    return 0;
  }
  
  return qty * (ltp - avgPrice);
}

function getSkeletonRows(cols, rows = 3) {
  let html = '';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) {
      let width = '90%';
      if (c === 0) width = '70%';
      else if (c === cols - 1) width = '55%';
      html += `<td><div class="skeleton-loader" style="height: 16px; width: ${width}; margin: 4px 0;"></div></td>`;
    }
    html += '</tr>';
  }
  return html;
}

async function refreshPortfolio(isBackground = false) {
  if (isBackground && isFetchingPortfolio) return;
  isFetchingPortfolio = true;

  const accountId = document.getElementById('portfolio-account').value;
  const posContainer = document.getElementById('portfolio-positions-list');
  const holdContainer = document.getElementById('portfolio-holdings-list');
  const pendingContainer = document.getElementById('portfolio-pending-list');
  const historyContainer = document.getElementById('portfolio-history-list');

  if (!isBackground) {
    // Reset UI with premium skeleton loaders
    posContainer.innerHTML = getSkeletonRows(6, 3);
    holdContainer.innerHTML = getSkeletonRows(7, 3);
    pendingContainer.innerHTML = getSkeletonRows(10, 3);
    historyContainer.innerHTML = getSkeletonRows(10, 3);
    
    document.getElementById('fund-cash').innerHTML = '<div class="skeleton-loader" style="height: 18px; width: 60px; display: inline-block;"></div>';
    document.getElementById('fund-utilized').innerHTML = '<div class="skeleton-loader" style="height: 18px; width: 60px; display: inline-block;"></div>';
    document.getElementById('fund-total').innerHTML = '<div class="skeleton-loader" style="height: 18px; width: 60px; display: inline-block;"></div>';
  }

  if (!accountId) {
    if (!isBackground) {
      posContainer.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Select an account first.</td></tr>';
      holdContainer.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Select an account first.</td></tr>';
      pendingContainer.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Select an account first.</td></tr>';
      historyContainer.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Select an account first.</td></tr>';
    }
    isFetchingPortfolio = false;
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/portfolio/${accountId}`);
    if (!response.ok) throw new Error('Failed to load portfolio statistics.');
    
    const data = await response.json();

    // Render Funds
    if (data.funds) {
      document.getElementById('fund-cash').textContent = `₹ ${data.funds.availableCash.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      document.getElementById('fund-utilized').textContent = `₹ ${data.funds.utilized.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      document.getElementById('fund-total').textContent = `₹ ${data.funds.margin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    // Render Positions
    posContainer.innerHTML = '';
    if (!data.positions || data.positions.length === 0) {
      posContainer.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No open positions found.</td></tr>';
    } else {
      // Sort positions: open (qty !== 0) first, closed (qty === 0) last
      data.positions.sort((a, b) => {
        const qtyA = a.netqty !== undefined ? safeParseFloat(a.netqty) : (a.buyquantity !== undefined && a.sellquantity !== undefined ? safeParseFloat(a.buyquantity) - safeParseFloat(a.sellquantity) : safeParseFloat(a.buyquantity || 0));
        const qtyB = b.netqty !== undefined ? safeParseFloat(b.netqty) : (b.buyquantity !== undefined && b.sellquantity !== undefined ? safeParseFloat(b.buyquantity) - safeParseFloat(b.sellquantity) : safeParseFloat(b.buyquantity || 0));
        const isOpenA = qtyA !== 0;
        const isOpenB = qtyB !== 0;
        if (isOpenA && !isOpenB) return -1;
        if (!isOpenA && isOpenB) return 1;
        return 0;
      });

      let totalPnl = 0;
      data.positions.forEach(pos => {
        const tr = document.createElement('tr');
        const symbol = pos.tradingsymbol || pos.symbol || 'N/A';
        const exchange = pos.exchange || 'NSE';
        const qty = pos.netqty !== undefined ? safeParseFloat(pos.netqty) : (pos.buyquantity !== undefined && pos.sellquantity !== undefined ? safeParseFloat(pos.buyquantity) - safeParseFloat(pos.sellquantity) : safeParseFloat(pos.buyquantity || 0));
        const avgPrice = getPositionAvgPrice(pos);
        const ltp = safeParseFloat(pos.ltp || pos.LTP || 0);
        
        const pnl = calculatePositionPnl(pos);
        totalPnl += pnl;

        const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
        const sign = pnl >= 0 ? '+' : '-';

        // Add fading styling if net quantity is 0
        if (qty === 0) {
          tr.className = 'position-closed';
        }

        tr.innerHTML = `
          <td><strong>${symbol}</strong></td>
          <td><span class="badge" style="background: rgba(255,255,255,0.05);">${exchange}</span></td>
          <td>${qty}</td>
          <td>₹ ${avgPrice.toFixed(2)}</td>
          <td>₹ ${ltp.toFixed(2)}</td>
          <td class="${pnlClass}" style="font-weight: 600;">${sign}₹ ${Math.abs(pnl).toFixed(2)}</td>
        `;
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => {
          openPositionDetails(pos, accountId);
        });
        posContainer.appendChild(tr);
      });

      // Add Total P&L row at the bottom
      const totalTr = document.createElement('tr');
      totalTr.style.fontWeight = 'bold';
      totalTr.style.background = 'rgba(255, 255, 255, 0.03)';
      const totalPnlClass = totalPnl >= 0 ? 'text-green' : 'text-red';
      const totalSign = totalPnl >= 0 ? '+' : '-';
      totalTr.innerHTML = `
        <td colspan="5" style="text-align: right; font-size: 13px;">Total P&L:</td>
        <td class="${totalPnlClass}" style="font-weight: 700; font-size: 13px;">${totalSign}₹ ${Math.abs(totalPnl).toFixed(2)}</td>
      `;
      posContainer.appendChild(totalTr);
    }

    // Render Mobile Positions Cards
    if (typeof renderMobilePositions === 'function') {
      renderMobilePositions(data.positions, 'mobile-portfolio-positions-portal', accountId);
      renderMobilePositions(data.positions, 'mobile-positions-container', accountId);
    }

    // Render Mobile Holdings Cards
    if (typeof renderMobileHoldings === 'function') {
      renderMobileHoldings(data.holdings, 'mobile-portfolio-holdings-portal');
    }

    // Render Holdings
    holdContainer.innerHTML = '';
    currentHoldingsData = data.holdings || [];
    if (!data.holdings || data.holdings.length === 0) {
      holdContainer.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No demat holdings found.</td></tr>';
    } else {
      let totalInvested = 0;
      let totalCurrent = 0;
      let totalPnl = 0;

      data.holdings.forEach(hold => {
        const tr = document.createElement('tr');
        const symbol = hold.tradingsymbol || hold.scripname || 'N/A';
        const exchange = hold.exchange || 'NSE';
        const qty = parseFloat(hold.quantity || hold.dpquantity || 0);
        const avgPrice = parseFloat(hold.averageprice || hold.buyavgprice || 0);
        const ltp = getLiveOrStaticLtp(hold);
        const currentValue = qty * ltp;
        const investedValue = qty * avgPrice;
        
        const pnl = currentValue - investedValue;

        totalInvested += investedValue;
        totalCurrent += currentValue;
        totalPnl += pnl;

        const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
        const sign = pnl >= 0 ? '+' : '';

        tr.innerHTML = `
          <td><strong>${symbol}</strong></td>
          <td><span class="badge" style="background: rgba(255,255,255,0.05);">${exchange}</span></td>
          <td>${qty}</td>
          <td>₹ ${avgPrice.toFixed(2)}</td>
          <td id="hold-ltp-${symbol}">₹ ${ltp.toFixed(2)}</td>
          <td id="hold-val-${symbol}">₹ ${currentValue.toFixed(2)}</td>
          <td id="hold-pnl-${symbol}" class="${pnlClass}" style="font-weight: 600;">₹ ${sign}${pnl.toFixed(2)}</td>
        `;
        holdContainer.appendChild(tr);
      });

      // Add Total Summary row at the bottom of desktop holdings
      const totalTr = document.createElement('tr');
      totalTr.style.fontWeight = 'bold';
      totalTr.style.background = 'rgba(255, 255, 255, 0.03)';
      
      const holdingsPnlClass = totalPnl >= 0 ? 'text-green' : 'text-red';
      const holdingsPnlSign = totalPnl >= 0 ? '+' : '';
      const totalChangePct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
      
      totalTr.innerHTML = `
        <td colspan="3" style="text-align: right; font-size: 13px; font-weight: 700;">Total Investment: <span id="desk-holdings-total-inv">₹ ${totalInvested.toFixed(2)}</span></td>
        <td colspan="2" style="text-align: right; font-size: 13px; font-weight: 700;">Current Value:</td>
        <td id="desk-holdings-total-val" style="font-weight: 700; font-size: 13px;">₹ ${totalCurrent.toFixed(2)}</td>
        <td id="desk-holdings-total-pnl" class="${holdingsPnlClass}" style="font-weight: 700; font-size: 13px;">₹ ${holdingsPnlSign}${totalPnl.toFixed(2)} (${holdingsPnlSign}${totalChangePct.toFixed(2)}%)</td>
      `;
      holdContainer.appendChild(totalTr);
    }

    // Fetch Orders
    const ordersResponse = await fetch(`${API_BASE}/orders/${accountId}`);
    const ordersData = await ordersResponse.json();
    
    // Sort orders: latest (by parsed order time) on top
    const sortedPending = (ordersData.pending || []).slice().sort((a, b) => parseOrderTime(b) - parseOrderTime(a));
    const sortedExecuted = (ordersData.executed || []).slice().sort((a, b) => parseOrderTime(b) - parseOrderTime(a));
    ordersData.pending = sortedPending;
    ordersData.executed = sortedExecuted;
    
    currentOrdersData = ordersData; // cache globally

    // Render Pending Orders
    pendingContainer.innerHTML = '';
    if (!ordersData.pending || ordersData.pending.length === 0) {
      pendingContainer.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">No pending orders.</td></tr>';
    } else {
      ordersData.pending.forEach(o => {
        const tr = document.createElement('tr');
        const badgeClass = (o.transactiontype || '').toLowerCase() === 'buy' ? 'status-confirm' : 'status-rejected';
        tr.innerHTML = `
          <td><span style="font-family: var(--font-mono); font-size:12px;">${o.orderid}</span></td>
          <td><strong>${o.tradingsymbol}</strong></td>
          <td><span class="badge" style="background: rgba(255,255,255,0.05);">${o.exchange}</span></td>
          <td><span class="badge ${badgeClass}">${o.transactiontype}</span></td>
          <td>${o.ordertype}</td>
          <td>${o.producttype}</td>
          <td>${o.quantity}</td>
          <td>₹ ${parseFloat(o.price || 0).toFixed(2)}</td>
          <td><span class="badge status-pending">${o.status}</span></td>
          <td style="text-align: center; white-space: nowrap;">
            <button class="btn btn-primary btn-modify-order" style="padding: 4px 10px; font-size: 11px; margin-right: 4px;" data-id="${o.orderid}">
              <i class="fa-solid fa-pen-to-square"></i> Edit
            </button>
            <button class="btn btn-danger btn-cancel-order" style="padding: 4px 10px; font-size: 11px;" data-id="${o.orderid}">
              <i class="fa-solid fa-xmark"></i> Cancel
            </button>
          </td>
        `;

        tr.querySelector('.btn-modify-order').addEventListener('click', () => {
          handleModifyOrder(o, accountId);
        });

        tr.querySelector('.btn-cancel-order').addEventListener('click', async () => {
          if (confirm(`Cancel pending order ${o.orderid}?`)) {
            try {
              const res = await fetch(`${API_BASE}/orders/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId, orderId: o.orderid })
              });
              if (res.ok) {
                const resData = await res.json();
                if (resData.status === true || resData.status === 'SUCCESS' || resData.success === true) {
                  alert('Order cancelled successfully!');
                  refreshPortfolio();
                  fetchLogs();
                } else {
                  alert('Cancellation failed: ' + (resData.message || resData.error || 'Broker API error'));
                }
              } else {
                alert('Error cancelling order.');
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }
        });

        pendingContainer.appendChild(tr);
      });
    }

    // Render Executed Orders
    historyContainer.innerHTML = '';
    if (!ordersData.executed || ordersData.executed.length === 0) {
      historyContainer.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">No order history found.</td></tr>';
    } else {
      ordersData.executed.forEach(o => {
        const tr = document.createElement('tr');
        const badgeClass = (o.transactiontype || '').toLowerCase() === 'buy' ? 'status-confirm' : 'status-rejected';
        const statusClass = `status-${(o.status || '').toLowerCase()}`;
        tr.innerHTML = `
          <td><span style="font-family: var(--font-mono); font-size:12px;">${o.orderid}</span></td>
          <td><strong>${o.tradingsymbol}</strong></td>
          <td><span class="badge" style="background: rgba(255,255,255,0.05);">${o.exchange}</span></td>
          <td><span class="badge ${badgeClass}">${o.transactiontype}</span></td>
          <td>${o.ordertype}</td>
          <td>${o.producttype}</td>
          <td>${o.quantity}</td>
          <td>₹ ${parseFloat(o.price || 0).toFixed(2)}</td>
          <td><span class="badge ${statusClass}">${o.status}</span></td>
          <td style="font-size: 11px; color: var(--text-secondary);">${o.updatetime}</td>
        `;
        historyContainer.appendChild(tr);
      });
    }

    // Render Mobile Orders Cards!
    renderMobileOrders();

    // Render Mobile Orders inside Portfolio tab portals
    if (typeof renderMobileOrdersList === 'function') {
      renderMobileOrdersList(ordersData.pending, 'mobile-portfolio-pending-portal', true);
      renderMobileOrdersList(ordersData.executed, 'mobile-portfolio-executed-portal', false);
    }

    // Apply live prices immediately on load
    updateLiveHoldingsPrices();

    isFetchingPortfolio = false;
  } catch (err) {
    posContainer.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--red);">${err.message}</td></tr>`;
    holdContainer.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--red);">${err.message}</td></tr>`;
    pendingContainer.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--red);">${err.message}</td></tr>`;
    historyContainer.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--red);">${err.message}</td></tr>`;
    
    // Render error message in mobile portal containers too
    const mobPortPos = document.getElementById('mobile-portfolio-positions-portal');
    const mobPosCont = document.getElementById('mobile-positions-container');
    const mobOrdList = document.getElementById('mobile-orders-list');
    const mobPortHold = document.getElementById('mobile-portfolio-holdings-portal');
    const mobPortPend = document.getElementById('mobile-portfolio-pending-portal');
    const mobPortExec = document.getElementById('mobile-portfolio-executed-portal');
    
    const errHtml = `<div style="text-align: center; color: var(--red); padding: 20px 0;">Error: ${err.message}</div>`;
    if (mobPortPos) mobPortPos.innerHTML = errHtml;
    if (mobPosCont) mobPosCont.innerHTML = errHtml;
    if (mobOrdList) mobOrdList.innerHTML = errHtml;
    if (mobPortHold) mobPortHold.innerHTML = errHtml;
    if (mobPortPend) mobPortPend.innerHTML = errHtml;
    if (mobPortExec) mobPortExec.innerHTML = errHtml;
    
    isFetchingPortfolio = false;
  }
}

function updateLiveHoldingsPrices() {
  if (!currentHoldingsData || currentHoldingsData.length === 0) return;

  let totalInvested = 0;
  let totalCurrent = 0;
  let totalPnl = 0;

  currentHoldingsData.forEach(hold => {
    const symbol = hold.tradingsymbol || hold.scripname || 'N/A';
    const qty = parseFloat(hold.quantity || hold.dpquantity || 0);
    const avgPrice = parseFloat(hold.averageprice || hold.buyavgprice || 0);
    
    const ltp = getLiveOrStaticLtp(hold);
    const prevClose = getLiveOrStaticPrevClose(hold);

    const currentValue = qty * ltp;
    const investedValue = qty * avgPrice;
    const pnl = currentValue - investedValue;

    totalInvested += investedValue;
    totalCurrent += currentValue;
    totalPnl += pnl;

    const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
    const sign = pnl >= 0 ? '+' : '';

    // 1. Update Desktop elements
    const deskLtpEl = document.getElementById(`hold-ltp-${symbol}`);
    if (deskLtpEl) {
      deskLtpEl.textContent = `₹ ${ltp.toFixed(2)}`;
    }
    const deskValEl = document.getElementById(`hold-val-${symbol}`);
    if (deskValEl) {
      deskValEl.textContent = `₹ ${currentValue.toFixed(2)}`;
    }
    const deskPnlEl = document.getElementById(`hold-pnl-${symbol}`);
    if (deskPnlEl) {
      deskPnlEl.textContent = `₹ ${sign}${pnl.toFixed(2)}`;
      deskPnlEl.className = pnlClass;
    }

    // 2. Update Mobile elements
    const mobLtpEl = document.getElementById(`mob-hold-ltp-${symbol}`);
    if (mobLtpEl) {
      mobLtpEl.textContent = `₹${ltp.toFixed(2)}`;
    }
    const mobPnlEl = document.getElementById(`mob-hold-pnl-${symbol}`);
    if (mobPnlEl) {
      mobPnlEl.textContent = `${sign}₹${Math.abs(pnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      mobPnlEl.className = `mobile-pos-card-pnl ${pnlClass}`;
    }
    const mobValEl = document.getElementById(`mob-hold-val-${symbol}`);
    if (mobValEl) {
      mobValEl.textContent = `₹${currentValue.toFixed(2)}`;
    }

    const mobChgEl = document.getElementById(`mob-hold-chg-${symbol}`);
    if (mobChgEl) {
      const changePct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
      const changeSign = changePct >= 0 ? '+' : '';
      const changeClass = changePct >= 0 ? 'text-green' : 'text-red';
      mobChgEl.textContent = `(${changeSign}${changePct.toFixed(2)}%)`;
      mobChgEl.className = changeClass;
    }
  });

  // 3. Update Summary elements (Desktop & Mobile)
  const holdingsPnlClass = totalPnl >= 0 ? 'text-green' : 'text-red';
  const holdingsPnlSign = totalPnl >= 0 ? '+' : '';
  const totalChangePct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  // Desktop summary
  const deskTotalInvEl = document.getElementById('desk-holdings-total-inv');
  if (deskTotalInvEl) {
    deskTotalInvEl.textContent = `₹ ${totalInvested.toFixed(2)}`;
  }
  const deskTotalValEl = document.getElementById('desk-holdings-total-val');
  if (deskTotalValEl) {
    deskTotalValEl.textContent = `₹ ${totalCurrent.toFixed(2)}`;
  }
  const deskTotalPnlEl = document.getElementById('desk-holdings-total-pnl');
  if (deskTotalPnlEl) {
    deskTotalPnlEl.textContent = `₹ ${holdingsPnlSign}${totalPnl.toFixed(2)} (${holdingsPnlSign}${totalChangePct.toFixed(2)}%)`;
    deskTotalPnlEl.className = holdingsPnlClass;
  }

  // Mobile summary
  const mobTotalInvEl = document.getElementById('mob-holdings-total-inv');
  if (mobTotalInvEl) {
    mobTotalInvEl.textContent = `₹${totalInvested.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const mobTotalPnlEl = document.getElementById('mob-holdings-total-pnl');
  if (mobTotalPnlEl) {
    mobTotalPnlEl.textContent = `${holdingsPnlSign}₹${Math.abs(totalPnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    mobTotalPnlEl.className = holdingsPnlClass;
  }
  const mobTotalValEl = document.getElementById('mob-holdings-total-val');
  if (mobTotalValEl) {
    mobTotalValEl.textContent = `₹${totalCurrent.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const mobTotalReturnEl = document.getElementById('mob-holdings-total-return');
  if (mobTotalReturnEl) {
    mobTotalReturnEl.textContent = `${holdingsPnlSign}${totalChangePct.toFixed(2)}%`;
    mobTotalReturnEl.className = holdingsPnlClass;
  }
}

async function handleModifyOrder(o, accountId) {
  const currentQty = o.quantity;
  const currentPrice = o.price;
  
  const newQtyStr = prompt(`Modify Order ${o.orderid} (${o.tradingsymbol})\nEnter new quantity:`, currentQty);
  if (newQtyStr === null) return; 
  const newQty = parseInt(newQtyStr);
  if (isNaN(newQty) || newQty <= 0) {
    alert('Invalid quantity.');
    return;
  }
  
  const newPriceStr = prompt(`Modify Order ${o.orderid} (${o.tradingsymbol})\nEnter new price:`, currentPrice);
  if (newPriceStr === null) return; 
  const newPrice = parseFloat(newPriceStr);
  if (isNaN(newPrice) || newPrice < 0) {
    alert('Invalid price.');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/orders/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        orderid: o.orderid,
        quantity: newQty,
        price: newPrice,
        ordertype: o.ordertype,
        symboltoken: o.symboltoken,
        exchange: o.exchange,
        producttype: o.producttype
      })
    });
    
    const resData = await response.json();
    if (response.ok && (resData.status === true || resData.status === 'SUCCESS' || resData.success === true)) {
      alert('Order modified successfully!');
      refreshPortfolio();
      fetchLogs();
    } else {
      alert('Order modification failed: ' + (resData.error || resData.message || 'Unknown error'));
    }
  } catch (err) {
    alert('Error modifying order: ' + err.message);
  }
}

function toTitleCase(str) {
  if (!str) return '';
  const keepUpper = ['NSE', 'BSE', 'Nifty', 'Sensex', 'IIFL', 'ICICI', 'HDFC', 'IDBI', 'IRFC', 'RVNL', 'SJVN', 'NHPC', 'BHEL', 'BEL', 'PNB', 'ONGC', 'NTPC', 'SAIL', 'REC', 'PFC', 'HUDCO', 'IREDA', 'IRCTC', 'MRF', 'ITC', 'TCS', 'INFY', 'L&T', 'L-T'];
  return str.toLowerCase().split(/\s+/).map(word => {
    const cleanWord = word.replace(/[^a-zA-Z]/g, '').toUpperCase();
    if (keepUpper.includes(cleanWord)) {
      return word.toUpperCase();
    }
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function parseDisplaySymbol(symbol, name = '', exchange = 'NSE') {
  const cleanSymbol = (symbol || '').toUpperCase().trim();
  const cleanName = (name || '').toUpperCase().trim();
  const cleanExch = (exchange || '').toUpperCase().trim();

  let baseSymbol = cleanSymbol;
  let subtitle = name || getCompanyName(cleanSymbol);
  let type = 'EQ';
  let resolvedExch = cleanExch;

  const formatExpiry = (exp) => {
    if (!exp) return '';
    const match = exp.match(/^(\d{1,2})([A-Z]{3})(\d{2,4})$/i);
    if (match) {
      const day = match[1];
      const month = match[2];
      let year = match[3];
      if (year.length === 4) year = year.substring(2, 4);
      return `${day.padStart(2, '0')}-${month}-${year}`;
    }
    return exp;
  };

  // Check for hyphenated synthetic format (e.g. NIFTY-25JUN26-FUT, NIFTY-25JUN26-19500-CE)
  if (cleanSymbol.includes('-FUT') || cleanSymbol.includes('-CE') || cleanSymbol.includes('-PE')) {
    const parts = cleanSymbol.split('-');
    baseSymbol = parts[0];
    const expiry = parts[1] ? formatExpiry(parts[1]) : '';
    const strike = parts[2] || '';
    
    if (cleanSymbol.includes('-FUT')) {
      type = 'FUT';
      subtitle = expiry;
    } else {
      const optType = cleanSymbol.includes('-CE') ? 'CE' : 'PE';
      type = optType;
      subtitle = `${expiry} ${strike} ${optType}`;
    }
    resolvedExch = 'NFO';
  } 
  // Check for concatenated format (e.g. SILVERMIC30JUN26FUT, NIFTY25JUN2619500CE)
  else {
    const futRegex = /^([A-Z&0-9]+?)(\d{2}[A-Z]{3}\d{2})FUT$/i;
    const optRegex = /^([A-Z&0-9]+?)(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/i;
    const spotRegex = /^([A-Z&]+)(COM|COMDTY)$/i;

    if (cleanSymbol.match(futRegex)) {
      const match = cleanSymbol.match(futRegex);
      baseSymbol = match[1];
      const expiry = formatExpiry(match[2]);
      type = 'FUT';
      subtitle = expiry;
      const mcxCommodities = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM', 'SILVERMIC', 'SILVERM', 'SILVER100', 'CRUDEOIL'];
      if (mcxCommodities.some(c => baseSymbol.includes(c)) || resolvedExch === 'MCX') {
        resolvedExch = 'MCX';
        type = 'CMD';
      } else {
        resolvedExch = 'NFO';
      }
    } else if (cleanSymbol.match(optRegex)) {
      const match = cleanSymbol.match(optRegex);
      baseSymbol = match[1];
      const expiry = formatExpiry(match[2]);
      const strike = match[3];
      const optType = match[4].toUpperCase();
      type = optType;
      subtitle = `${expiry} ${strike} ${optType}`;
      const mcxCommodities = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM', 'SILVERMIC', 'SILVERM', 'SILVER100', 'CRUDEOIL'];
      if (mcxCommodities.some(c => baseSymbol.includes(c)) || resolvedExch === 'MCX') {
        resolvedExch = 'MCX';
        type = 'CMD';
      } else {
        resolvedExch = 'NFO';
      }
    } else if (cleanSymbol.match(spotRegex)) {
      const match = cleanSymbol.match(spotRegex);
      baseSymbol = match[1];
      subtitle = 'COMMODITY SPOT';
      type = 'CMD';
      resolvedExch = 'MCX';
    } else {
      baseSymbol = cleanSymbol.replace('-EQ', '');
      if (cleanSymbol.includes('ETF') || cleanName.includes('ETF') || cleanSymbol.includes('CASE') || cleanSymbol.includes('IETF')) {
        type = 'ETF';
      } else {
        type = 'EQ';
      }
      subtitle = name || getCompanyName(cleanSymbol);
    }
  }

  if (type === 'EQ' && subtitle) {
    subtitle = toTitleCase(subtitle);
  }

  return {
    baseSymbol,
    subtitle,
    exchange: resolvedExch,
    type
  };
}

function getSymbolExchange(symbol) {
  if (!symbol) return 'NSE';
  if (symbol.endsWith('-EQ')) {
    if (symbol === 'SENSEX-EQ') return 'BSE';
    return 'NSE';
  }
  if (symbol === 'NIFTY-EQ' || symbol === 'BANKNIFTY-EQ' || symbol === 'FINNIFTY-EQ') {
    return 'NSE';
  }
  // Check common commodities or if it has FUT/CE/PE
  const parts = symbol.split('-');
  let underlying = symbol;
  let isDeriv = false;
  if (parts.length >= 3) {
    underlying = parts[0];
    isDeriv = true;
  } else {
    // E.g. SILVERMIC30JUN26FUT
    const futRegex = /^([A-Z]+)(\d{2}[A-Z]{3}\d{2})FUT$/;
    const optRegex = /^([A-Z]+)(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;
    if (symbol.match(futRegex) || symbol.match(optRegex)) {
      isDeriv = true;
      const match = symbol.match(futRegex) || symbol.match(optRegex);
      underlying = match[1];
    }
  }
  
  if (isDeriv) {
    if (underlying === 'NIFTY' || underlying === 'BANKNIFTY' || underlying === 'FINNIFTY') {
      return 'NFO';
    }
    // Check if commodity
    const commodities = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM', 'MCX', 'SILVERMIC'];
    if (commodities.some(c => underlying.toUpperCase().includes(c))) {
      return 'MCX';
    }
    return 'NFO';
  }
  
  return 'NSE';
}

function renderWatchlistTable() {
  const container = document.getElementById('watchlist-items');
  if (!container) return;

  if (watchlistSymbols.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 30px 0; font-size: 14px; width: 100%;">Watchlist is empty. Search above to add stocks.</div>';
    return;
  }

  // 1. Remove rows that are no longer in watchlistSymbols
  const existingRows = container.querySelectorAll('.watchlist-item-row');
  existingRows.forEach(row => {
    const rowSymbol = row.id.replace('wl-row-', '');
    if (!watchlistSymbols.includes(rowSymbol)) {
      row.remove();
    }
  });

  // Remove empty states text if present (i.e. child element without id)
  if (container.firstElementChild && !container.firstElementChild.id) {
    container.innerHTML = '';
  }

  // 2. Add or update rows in order
  watchlistSymbols.forEach((symbol, index) => {
    let row = document.getElementById(`wl-row-${symbol}`);
    
    const data = watchlistPrices[symbol] || { ltp: 100.00, change: 'flat', prevClose: 100.00 };
    const priceDisplay = data.ltp > 0 ? `₹${data.ltp.toFixed(2)}` : 'Loading...';
    
    const prevClose = data.prevClose || data.ltp;
    const diff = data.ltp - prevClose;
    const pct = prevClose > 0 ? (diff / prevClose) * 100 : 0;
    const rawExchange = getSymbolExchange(symbol);

    let trendClass = 'text-green';
    let sign = '+';
    if (diff < 0) {
      trendClass = 'text-red';
      sign = '-';
    } else if (diff === 0) {
      trendClass = 'text-muted';
      sign = '';
    }

    const companyName = getCompanyName(symbol);
    const parsed = parseDisplaySymbol(symbol, companyName, rawExchange);
    const cleanSym = parsed.baseSymbol;
    const subtitle = parsed.subtitle;
    const exchange = parsed.exchange;
    const typeText = parsed.type;

    // Determine type badge styling for watchlist table
    let typeBadgeBg = 'rgba(59, 130, 246, 0.15)';
    let typeBadgeColor = '#60a5fa';
    if (typeText === 'CMD') {
      typeBadgeBg = 'rgba(20, 184, 166, 0.15)';
      typeBadgeColor = '#2dd4bf';
    } else if (typeText === 'EQ') {
      typeBadgeBg = 'rgba(99, 102, 241, 0.15)';
      typeBadgeColor = '#818cf8';
    } else if (typeText === 'FUT') {
      typeBadgeBg = 'rgba(245, 158, 11, 0.15)';
      typeBadgeColor = '#fbbf24';
    } else if (typeText === 'CE') {
      typeBadgeBg = 'rgba(16, 185, 129, 0.15)';
      typeBadgeColor = '#34d399';
    } else if (typeText === 'PE') {
      typeBadgeBg = 'rgba(239, 68, 68, 0.15)';
      typeBadgeColor = '#f87171';
    } else if (typeText === 'ETF') {
      typeBadgeBg = 'rgba(107, 114, 128, 0.15)';
      typeBadgeColor = '#9ca3af';
    }

    if (!row) {
      row = document.createElement('div');
      row.className = 'watchlist-item-row';
      row.id = `wl-row-${symbol}`;
      row.innerHTML = `
        <div class="wl-item-left" onclick="openStockDetails('${symbol}')" style="display:flex; justify-content:space-between; width:100%; align-items:center; cursor:pointer;">
          <div class="wl-info-block" style="display:flex; flex-direction:column; gap:4px; flex: 1; min-width: 0;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="wl-sym" style="font-weight: 600; color: var(--text-primary); font-size: 14px; white-space: nowrap;">${cleanSym}</span>
              <span class="wl-exchange-badge" style="background: rgba(255,255,255,0.06); color: var(--text-secondary); font-size: 9px; padding: 1px 4px; border-radius: 4px; font-weight: 600; width:fit-content; line-height: 1.2;">${exchange}</span>
              <span class="wl-type-badge" style="background: ${typeBadgeBg}; color: ${typeBadgeColor}; font-size: 9px; padding: 1px 4px; border-radius: 4px; font-weight: 600; width:fit-content; line-height: 1.2;">${typeText}</span>
            </div>
            <span class="wl-company" style="color: var(--text-secondary); opacity: 0.6; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; display: block;">${subtitle}</span>
          </div>
          
          <div class="wl-price-block" style="text-align:right; display:flex; flex-direction:column; gap:4px; flex-shrink: 0; align-items: flex-end;">
            <span class="wl-price" id="wl-price-${symbol}" style="font-weight: 600; color: var(--text-primary); font-size: 14px; font-family: var(--font-mono);">${priceDisplay}</span>
            <span class="wl-change ${trendClass}" id="wl-trend-${symbol}" style="font-size: 11px; font-weight: 500; font-family: var(--font-mono); white-space: nowrap;">
              ${sign}${Math.abs(diff).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)
            </span>
          </div>
        </div>
      `;
      // Insert row at the correct position to preserve order
      if (index === 0) {
        container.insertBefore(row, container.firstChild);
      } else {
        const prevSymbol = watchlistSymbols[index - 1];
        const prevRow = document.getElementById(`wl-row-${prevSymbol}`);
        if (prevRow && prevRow.nextSibling) {
          container.insertBefore(row, prevRow.nextSibling);
        } else {
          container.appendChild(row);
        }
      }
    } else {
      // Row already exists, update only price & trend text elements
      const priceEl = document.getElementById(`wl-price-${symbol}`);
      const trendEl = document.getElementById(`wl-trend-${symbol}`);
      if (priceEl && trendEl) {
        priceEl.textContent = priceDisplay;
        trendEl.textContent = `${sign}${Math.abs(diff).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
        trendEl.className = `wl-change ${trendClass}`;
      }
    }
  });
}

window.switchWatchlistTab = async function(tabNum) {
  currentWatchlistTab = String(tabNum);
  
  // Update tab active UI styling
  const tabs = document.querySelectorAll('.wl-tab');
  tabs.forEach(tab => {
    if (tab.textContent.trim() === String(tabNum)) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Fetch updated symbols for this watchlist tab
  try {
    const wlResponse = await fetch(`${API_BASE}/watchlist?tab=${currentWatchlistTab}`);
    watchlistSymbols = await wlResponse.json();
    renderWatchlistTable();
    pollWatchlistPrices(); // fetch prices immediately
  } catch (err) {
    console.error('Error switching watchlist tab:', err);
  }
};

async function handleAddWatchlist() {
  const input = document.getElementById('watchlist-search');
  const symbol = input.value.trim().toUpperCase();
  
  if (!symbol) return;

  if (watchlistSymbols.length >= 20 && !watchlistSymbols.includes(symbol)) {
    showNotification("Watchlist limit reached (Max 20 symbols)", "error");
    return;
  }

  // Hide suggestions box and restore index display on add
  const suggestionsBox = document.getElementById('watchlist-suggestions');
  if (suggestionsBox) {
    suggestionsBox.innerHTML = '';
    suggestionsBox.classList.add('hidden');
  }
  showWatchlistIndices();

  try {
    const response = await fetch(`${API_BASE}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, tab: currentWatchlistTab })
    });

    if (response.ok) {
      const res = await response.json();
      watchlistSymbols = res.watchlist;
      input.value = '';
      renderWatchlistTable();
      pollWatchlistPrices(); // Fetch prices immediately for new item
    } else {
      alert('Failed to add symbol.');
    }
  } catch (err) {
    console.error('Error adding watchlist item:', err);
  }
}

function handleWatchlistPricesData(data) {
  if (!data) return;
  const prices = data.prices || {};
  const marketOpen = data.marketOpen;

  // Update Market Status Badge in the UI dynamically
  const marketStatusBadge = document.getElementById('market-status-badge');
  if (marketStatusBadge) {
    if (marketOpen) {
      marketStatusBadge.textContent = 'OPEN';
      marketStatusBadge.className = 'text-green';
      marketStatusBadge.style.fontWeight = '600';
    } else {
      marketStatusBadge.textContent = 'CLOSED (Showing Last Close)';
      marketStatusBadge.className = 'text-red';
      marketStatusBadge.style.fontWeight = '600';
    }
  }

  const lastTickEl = document.getElementById('watchlist-last-tick');
  if (lastTickEl) {
    lastTickEl.textContent = new Date().toLocaleTimeString();
  }

  for (const symbol in prices) {
    const priceData = prices[symbol];
    const prevData = watchlistPrices[symbol];
    
    // Update global price state
    watchlistPrices[symbol] = priceData;

    // Update custom chart series if active
    if (typeof window.updateLwChartLiveTick === 'function') {
      window.updateLwChartLiveTick(symbol, priceData.ltp);
    }

    const priceTd = document.getElementById(`wl-price-${symbol}`);
    const trendTd = document.getElementById(`wl-trend-${symbol}`);
    const isUpToday = priceData.ltp >= priceData.prevClose;
    const baseTrendClass = isUpToday ? 'text-green' : 'text-red';

    if (priceTd) {
      const oldPriceText = priceTd.textContent.replace('₹', '');
      const oldPrice = parseFloat(oldPriceText) || 0;
      const currentPrice = parseFloat(priceData.ltp) || 0;
      
      if (oldPrice > 0 && oldPrice !== currentPrice && currentPrice > 0) {
        const flashClass = currentPrice > oldPrice ? 'flash-up' : 'flash-down';
        priceTd.classList.remove('flash-up', 'flash-down');
        void priceTd.offsetWidth; // Trigger reflow to restart animation
        priceTd.classList.add(flashClass);
      }
      
      priceTd.textContent = `₹${currentPrice.toFixed(2)}`;
      priceTd.className = `wl-price`;
    }
    
    if (trendTd) {
      const diff = priceData.ltp - priceData.prevClose;
      const pct = priceData.prevClose > 0 ? (diff / priceData.prevClose) * 100 : 0;
      trendTd.className = `wl-change ${baseTrendClass}`;
      trendTd.innerHTML = `${isUpToday ? '+' : ''}${Math.abs(diff).toFixed(2)} (${isUpToday ? '+' : ''}${Math.abs(pct).toFixed(2)}%)`;
    }

    // Update live price inside search suggestions list if present
    const suggPrice = document.getElementById(`sugg-price-${symbol}`);
    const suggTrend = document.getElementById(`sugg-trend-${symbol}`);
    if (suggPrice) {
      suggPrice.textContent = `₹${parseFloat(priceData.ltp).toFixed(2)}`;
    }
    if (suggTrend) {
      const diff = priceData.ltp - priceData.prevClose;
      const pct = priceData.prevClose > 0 ? (diff / priceData.prevClose) * 100 : 0;
      suggTrend.className = baseTrendClass;
      suggTrend.textContent = `${isUpToday ? '+' : ''}${Math.abs(diff).toFixed(2)} (${isUpToday ? '+' : ''}${Math.abs(pct).toFixed(2)}%)`;
    }

    // If this stock is currently open in the details sheet, update its price dynamically!
    if (currentSelectedStock && currentSelectedStock.symbol.toUpperCase() === symbol.toUpperCase()) {
      updateBSPrice(priceData.ltp, priceData.prevClose, priceData.change);
      updateBSMarketDepthPrices(priceData.ltp, priceData.depth);
      
      if (priceData.open !== undefined) {
        const bsOpenEl = document.getElementById('bs-stat-open');
        const bsHighEl = document.getElementById('bs-stat-high');
        const bsLowEl = document.getElementById('bs-stat-low');
        const bsCloseEl = document.getElementById('bs-stat-close');
        
        if (bsOpenEl) bsOpenEl.textContent = parseFloat(priceData.open).toFixed(2);
        if (bsHighEl) bsHighEl.textContent = parseFloat(priceData.high).toFixed(2);
        if (bsLowEl) bsLowEl.textContent = parseFloat(priceData.low).toFixed(2);
        if (bsCloseEl) bsCloseEl.textContent = parseFloat(priceData.prevClose).toFixed(2);
      }
      
      // Also update order placement details if open
      const orderModal = document.getElementById('order-placement-modal');
      if (orderModal && !orderModal.classList.contains('hidden')) {
        const nsePriceVal = priceData.ltp;
        const bsePriceVal = priceData.ltp - 0.25;
        
        const nseEl = document.getElementById('order-nse-price');
        const bseEl = document.getElementById('order-bse-price');
        if (nseEl) nseEl.textContent = `₹${nsePriceVal.toFixed(2)}`;
        if (bseEl) bseEl.textContent = `₹${bsePriceVal.toFixed(2)}`;
        
        const prevCloseVal = priceData.prevClose || nsePriceVal;
        const diffVal = nsePriceVal - prevCloseVal;
        const changePctVal = prevCloseVal > 0 ? (diffVal / prevCloseVal) * 100 : 0;
        const orderChangeEl = document.getElementById('order-nse-change');
        if (orderChangeEl) {
          const isUp = nsePriceVal >= prevCloseVal;
          orderChangeEl.className = isUp ? 'text-green' : 'text-red';
          orderChangeEl.textContent = `(${isUp ? '+' : ''}${changePctVal.toFixed(2)}%)`;
        }
        
        if (currentOrderMode === 'MARKET') {
          const price = currentOrderExchange === 'NSE' ? nsePriceVal : bsePriceVal;
          const orderPriceInput = document.getElementById('order-price');
          if (orderPriceInput) orderPriceInput.value = price.toFixed(2);
          calculateOrderMargin();
        }
      }
    }
  }

  // Update NIFTY and SENSEX indices from backend prices with flash ticks
  if (prices['NIFTY-EQ']) {
    const niftyVal = prices['NIFTY-EQ'].ltp;
    const niftyLtpEl = document.getElementById('index-nifty-ltp');
    if (niftyLtpEl) {
      const prevNiftyVal = parseFloat(niftyLtpEl.textContent.replace(/,/g, '')) || 0;
      niftyLtpEl.textContent = niftyVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (prevNiftyVal && prevNiftyVal !== niftyVal) {
        const prevNiftyClose = prices['NIFTY-EQ'].prevClose || niftyVal;
        const isUp = niftyVal >= prevNiftyClose;
        niftyLtpEl.className = `index-ltp ${isUp ? 'text-green' : 'text-red'}`;
      }
    }
    
    if (typeof window.updateLwChartLiveTick === 'function') {
      window.updateLwChartLiveTick('NIFTY', niftyVal);
    }
    
    const niftyChangeEl = document.getElementById('index-nifty-change');
    if (niftyChangeEl) {
      const prevNiftyClose = prices['NIFTY-EQ'].prevClose || niftyVal;
      const diff = niftyVal - prevNiftyClose;
      const pct = (prevNiftyClose > 0) ? (diff / prevNiftyClose) * 100 : 0;
      niftyChangeEl.textContent = `${diff >= 0 ? '+' : ''}${diff.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      niftyChangeEl.className = diff >= 0 ? 'index-change text-green' : 'index-change text-red';
    }
  }
  
  if (prices['SENSEX-EQ']) {
    const sensexVal = prices['SENSEX-EQ'].ltp;
    const sensexLtpEl = document.getElementById('index-sensex-ltp');
    if (sensexLtpEl) {
      const prevSensexVal = parseFloat(sensexLtpEl.textContent.replace(/,/g, '')) || 0;
      sensexLtpEl.textContent = sensexVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (prevSensexVal && prevSensexVal !== sensexVal) {
        const prevSensexClose = prices['SENSEX-EQ'].prevClose || sensexVal;
        const isUp = sensexVal >= prevSensexClose;
        sensexLtpEl.className = `index-ltp ${isUp ? 'text-green' : 'text-red'}`;
      }
    }
    
    const sensexChangeEl = document.getElementById('index-sensex-change');
    if (sensexChangeEl) {
      const prevSensexClose = prices['SENSEX-EQ'].prevClose || sensexVal;
      const diff = sensexVal - prevSensexClose;
      const pct = (prevSensexClose > 0) ? (diff / prevSensexClose) * 100 : 0;
      sensexChangeEl.textContent = `${diff >= 0 ? '+' : ''}${diff.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      sensexChangeEl.className = diff >= 0 ? 'index-change text-green' : 'index-change text-red';
    }
  }

  // Update live holdings prices from the newly received ticks
  updateLiveHoldingsPrices();
}

async function pollWatchlistPrices() {
  if (watchlistSymbols.length === 0 && !currentSelectedStock) return;
  try {
    const activeSymbol = currentSelectedStock ? currentSelectedStock.symbol : '';
    const response = await fetch(`${API_BASE}/watchlist/prices?t=${Date.now()}&active=${encodeURIComponent(activeSymbol)}`, { cache: 'no-store' });
    const data = await response.json();
    handleWatchlistPricesData(data);
  } catch (err) {
    console.error('Error polling watchlist prices:', err);
  }
}

let priceWebSocket = null;

function startPricePolling() {
  const activeSymbol = currentSelectedStock ? currentSelectedStock.symbol : '';

  // Reuse existing open WebSocket if available
  if (priceWebSocket && priceWebSocket.readyState === WebSocket.OPEN) {
    console.log('[WS] Reusing open WebSocket, subscribing to:', activeSymbol);
    try {
      priceWebSocket.send(JSON.stringify({ type: 'subscribe', activeSymbol }));
      return;
    } catch (e) {
      console.warn('[WS] Failed to send subscription message, reconnecting...', e.message);
    }
  }

  if (priceWebSocket) {
    try { priceWebSocket.close(); } catch(e) {}
    priceWebSocket = null;
  }
  if (pricePoller) {
    clearInterval(pricePoller);
    pricePoller = null;
  }

  // Resolve WebSocket URL from API_BASE
  let wsUrl;
  if (API_BASE.startsWith('http')) {
    wsUrl = API_BASE.replace(/^http/, 'ws');
  } else {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    // Handle leading/trailing slashes
    const base = API_BASE ? (API_BASE.startsWith('/') ? API_BASE : '/' + API_BASE) : '';
    wsUrl = `${protocol}//${host}${base}`;
  }
  
  wsUrl = `${wsUrl}/api/watchlist/stream?active=${encodeURIComponent(activeSymbol)}`;
  console.log('[WS] Connecting to watchlist price WebSocket...', wsUrl);

  try {
    priceWebSocket = new WebSocket(wsUrl);

    let firstMessageReceived = false;
    const wsTimeout = setTimeout(() => {
      if (!firstMessageReceived) {
        console.warn('[WS] No message received within 5 seconds. Falling back to HTTP polling...');
        fallbackToHttpPolling();
      }
    }, 5000);

    priceWebSocket.onmessage = function(event) {
      firstMessageReceived = true;
      clearTimeout(wsTimeout);
      try {
        const data = JSON.parse(event.data);
        handleWatchlistPricesData(data);
      } catch(e) {
        console.error('[WS] Failed to parse message data:', e);
      }
    };

    priceWebSocket.onerror = function(err) {
      console.warn('[WS] WebSocket error. Falling back to HTTP polling...', err);
      clearTimeout(wsTimeout);
      fallbackToHttpPolling();
    };

    priceWebSocket.onclose = function() {
      console.log('[WS] WebSocket connection closed.');
      clearTimeout(wsTimeout);
      // Wait briefly to check if we should fall back
      setTimeout(() => {
        if (!priceWebSocket && !pricePoller) {
          console.log('[WS] WS closed. Starting fallback polling.');
          fallbackToHttpPolling();
        }
      }, 100);
    };

    function fallbackToHttpPolling() {
      if (priceWebSocket) {
        try { priceWebSocket.close(); } catch(e) {}
        priceWebSocket = null;
      }
      if (!pricePoller) {
        console.log('[WS Fallback] Initializing HTTP Polling...');
        setTimeout(pollWatchlistPrices, 50);
        pricePoller = setInterval(pollWatchlistPrices, 1000);
      }
    }
  } catch (err) {
    console.error('[WS] Failed to initialize WebSocket. Falling back to HTTP polling...', err);
    if (!pricePoller) {
      setTimeout(pollWatchlistPrices, 50);
      pricePoller = setInterval(pollWatchlistPrices, 1000);
    }
  }
}

// --- Premium Watchlist & Stock Details Helpers ---

function cleanCompanyName(name) {
  if (!name) return '';
  return name
    .replace(/\bCompany\b/gi, 'Co')
    .replace(/\bLimited\b/gi, 'Ltd')
    .replace(/\bLtd\b/gi, 'Ltd')
    .replace(/\bLTD\b/gi, 'Ltd');
}

function getCompanyName(symbol) {
  const base = symbol.replace('-EQ', '');
  const mapping = {
    'SBIN': 'State Bank of India',
    'AXISBANK': 'Axis Bank Limited',
    'SBILIFE': 'SBI Life Insurance Company',
    'INFY': 'Infosys Limited',
    'TCS': 'Tata Consultancy Services',
    'RVNL': 'Rail Vikas Nigam Limited',
    'RELIANCE': 'Reliance Industries Limited',
    'TATASTEEL': 'Tata Steel Limited',
    'M&M': 'Mahindra & Mahindra Limited',
    'M&MFIN': 'Mahindra & Mahindra Financial Services Limited',
    'SMLMAH': 'SML Mahindra Limited'
  };
  let name = mapping[base];
  if (!name) {
    if (symbol.includes('FUT') || symbol.includes('CE') || symbol.includes('PE')) {
      const parts = symbol.split('-');
      const baseSym = parts[0];
      const baseName = mapping[baseSym] || baseSym;
      const expiry = parts[1] || '';
      let formattedExpiry = expiry;
      if (expiry.length >= 5) {
        const day = expiry.substring(0, 2);
        const month = expiry.substring(2, 5);
        formattedExpiry = `${day} ${month}`;
      }
      
      if (symbol.includes('FUT')) {
        name = `${baseName} ${formattedExpiry} Futures`;
      } else {
        const strike = parts[2] || '';
        const optType = symbol.includes('CE') ? 'Call' : 'Put';
        name = `${baseName} ${formattedExpiry} ${strike} ${optType}`;
      }
    } else {
      name = base + ' Limited';
    }
  }
  return cleanCompanyName(name);
}

async function handleRemoveWatchlist(symbol) {
  try {
    const response = await fetch(`${API_BASE}/watchlist/${encodeURIComponent(symbol)}?tab=${currentWatchlistTab}`, { method: 'DELETE' });
    if (response.ok) {
      const res = await response.json();
      watchlistSymbols = res.watchlist;
      renderWatchlistTable();
      
      if (currentSelectedStock && currentSelectedStock.symbol === symbol) {
        closeStockDetails();
      }
    }
  } catch (err) {
    console.error('Failed to delete watchlist symbol:', err);
  }
}

async function handleClearWatchlist() {
  if (confirm('Are you sure you want to clear your watchlist?')) {
    try {
      for (const symbol of [...watchlistSymbols]) {
        await fetch(`${API_BASE}/watchlist/${encodeURIComponent(symbol)}?tab=${currentWatchlistTab}`, { method: 'DELETE' });
      }
      watchlistSymbols = [];
      renderWatchlistTable();
      closeStockDetails();
      closeOrderPlacement();
    } catch (err) {
      console.error('Failed to clear watchlist:', err);
    }
  }
}

function triggerQuickOrder(symbol, side) {
  fetch(`${API_BASE}/stocks/info?symbol=${encodeURIComponent(symbol)}`)
    .then(res => res.json())
    .then(stockInfo => {
      const priceData = watchlistPrices[symbol] || { ltp: stockInfo.price || 100.00 };
      openOrderPlacement(side, stockInfo, priceData.ltp);
    })
    .catch(err => console.error(err));
}

function openStockDetails(symbol) {
  pushModalHistory('stock-details');
  // 1. Immediately clear/set temporary state
  activePosition = null;
  
  // Try to use already cached price data or construct a fallback
  const priceData = watchlistPrices[symbol] || {
    ltp: 100.00,
    open: 100.00,
    high: 100.00,
    low: 100.00,
    prevClose: 100.00,
    change: 'flat',
    depth: null
  };
  
  // Set temporary selected stock object to allow BUY/SELL clicks even before fetch finishes
  const tempStockInfo = {
    symbol: symbol,
    name: getCompanyName(symbol),
    price: priceData.ltp,
    open: priceData.open,
    high: priceData.high,
    low: priceData.low,
    prevClose: priceData.prevClose
  };
  currentSelectedStock = tempStockInfo;

  // 2. Immediately populate UI with what we have in cache
  const parsedCached = parseDisplaySymbol(symbol, tempStockInfo.name, getSymbolExchange(symbol));
  document.getElementById('bs-symbol').textContent = parsedCached.baseSymbol;
  document.getElementById('bs-company').textContent = `${parsedCached.subtitle} • ${parsedCached.exchange}`;
  
  const ltp = priceData.ltp;
  const prevCloseVal = priceData.prevClose || ltp;
  updateBSPrice(ltp, prevCloseVal, priceData.change);
  
  document.getElementById('bs-stat-open').textContent = priceData.open ? priceData.open.toFixed(2) : '...';
  document.getElementById('bs-stat-high').textContent = priceData.high ? priceData.high.toFixed(2) : '...';
  document.getElementById('bs-stat-low').textContent = priceData.low ? priceData.low.toFixed(2) : '...';
  document.getElementById('bs-stat-close').textContent = prevCloseVal ? prevCloseVal.toFixed(2) : '...';
  
  renderMarketDepth(ltp, priceData.depth);
  
  // Reset buttons to normal watchlist details
  const posActions = document.getElementById('bs-position-actions');
  if (posActions) posActions.classList.add('hidden');
  
  const starBtn = document.getElementById('bs-btn-star');
  if (starBtn) starBtn.classList.remove('hidden');
  
  const buyBtn = document.getElementById('bs-btn-buy');
  const sellBtn = document.getElementById('bs-btn-sell');
  
  buyBtn.textContent = 'BUY';
  buyBtn.className = 'btn btn-buy flex-1';
  buyBtn.onclick = () => {
    openOrderPlacement('BUY', currentSelectedStock || tempStockInfo, currentSelectedStock ? currentSelectedStock.price : ltp);
  };
  
  sellBtn.textContent = 'SELL';
  sellBtn.className = 'btn btn-sell flex-1';
  sellBtn.onclick = () => {
    openOrderPlacement('SELL', currentSelectedStock || tempStockInfo, currentSelectedStock ? currentSelectedStock.price : ltp);
  };
  
  const modal = document.getElementById('stock-details-modal');
  if (modal) modal.classList.remove('hidden');
  
  updateBSStarButton(symbol);

  // 3. Trigger asynchronous background fetch to get full and updated details
  fetch(`${API_BASE}/stocks/info?symbol=${encodeURIComponent(symbol)}`)
    .then(res => {
      if (!res.ok) throw new Error('Stock not found');
      return res.json();
    })
    .then(stockInfo => {
      // If user closed the details sheet or switched to another stock during the fetch, ignore
      if (!currentSelectedStock || currentSelectedStock.symbol !== symbol) return;
      
      currentSelectedStock = stockInfo;
      
      // Update global price state cache
      watchlistPrices[symbol] = {
        ltp: stockInfo.price || 100.00,
        open: stockInfo.open || stockInfo.price || 100.00,
        high: stockInfo.high || stockInfo.price || 100.00,
        low: stockInfo.low || stockInfo.price || 100.00,
        prevClose: stockInfo.prevClose || stockInfo.price || 100.00,
        change: (stockInfo.price >= (stockInfo.prevClose || stockInfo.price)) ? 'up' : 'down',
        depth: stockInfo.depth || priceData.depth
      };
      
      const updatedPriceData = watchlistPrices[symbol];
      const updatedLtp = updatedPriceData.ltp;
      
      // Update company name text if backend has a more accurate name
      const parsedUpdated = parseDisplaySymbol(symbol, cleanCompanyName(stockInfo.name), getSymbolExchange(symbol));
      document.getElementById('bs-company').textContent = `${parsedUpdated.subtitle} • ${parsedUpdated.exchange}`;
      
      updateBSPrice(updatedLtp, updatedPriceData.prevClose, updatedPriceData.change);
      
      document.getElementById('bs-stat-open').textContent = updatedPriceData.open.toFixed(2);
      document.getElementById('bs-stat-high').textContent = updatedPriceData.high.toFixed(2);
      document.getElementById('bs-stat-low').textContent = updatedPriceData.low.toFixed(2);
      document.getElementById('bs-stat-close').textContent = updatedPriceData.prevClose.toFixed(2);
      
      renderMarketDepth(updatedLtp, updatedPriceData.depth);
      
      buyBtn.onclick = () => {
        openOrderPlacement('BUY', stockInfo, updatedLtp);
      };
      sellBtn.onclick = () => {
        openOrderPlacement('SELL', stockInfo, updatedLtp);
      };
    })
    .catch(err => {
      console.error('Failed to load updated stock details in background:', err);
    });
}

function closeStockDetails(preventPop) {
  const modal = document.getElementById('stock-details-modal');
  if (modal) modal.classList.add('hidden');
  const posActions = document.getElementById('bs-position-actions');
  if (posActions) posActions.classList.add('hidden');
  const starBtn = document.getElementById('bs-btn-star');
  if (starBtn) starBtn.classList.remove('hidden');
  currentSelectedStock = null;
  activePosition = null;
  if (!preventPop) {
    popModalHistory('stock-details');
  }
}

let activePosition = null;

async function openPositionDetails(pos, accountId) {
  pushModalHistory('stock-details');
  try {
    const symbol = pos.tradingsymbol || pos.symbol || '';
    const exchange = pos.exchange || 'NSE';
    const qty = pos.netqty !== undefined ? safeParseFloat(pos.netqty) : (pos.buyquantity !== undefined && pos.sellquantity !== undefined ? safeParseFloat(pos.buyquantity) - safeParseFloat(pos.sellquantity) : safeParseFloat(pos.buyquantity || 0));
    
    // Fetch stock info for company details & high/low/open/close stats
    let stockInfo = null;
    try {
      const response = await fetch(`${API_BASE}/stocks/info?symbol=${encodeURIComponent(symbol)}`);
      if (response.ok) {
        stockInfo = await response.json();
      }
    } catch (e) {
      console.warn('Failed to fetch stock info, using fallback data:', e);
    }
    
    if (!stockInfo) {
      // Fallback stockInfo
      stockInfo = {
        symbol: symbol,
        name: getCompanyName(symbol),
        token: pos.symboltoken || '',
        price: safeParseFloat(pos.ltp || 0)
      };
    }
    
    currentSelectedStock = stockInfo;
    activePosition = { pos, accountId };
    
    // Set global watchlistPrices using live stockInfo if available
    if (!watchlistPrices[symbol] || stockInfo) {
      watchlistPrices[symbol] = {
        ltp: stockInfo ? safeParseFloat(stockInfo.price || pos.ltp || 0) : safeParseFloat(pos.ltp || 0),
        open: stockInfo ? safeParseFloat(stockInfo.open || stockInfo.price || pos.ltp || 0) : safeParseFloat(pos.ltp || 0),
        high: stockInfo ? safeParseFloat(stockInfo.high || stockInfo.price || pos.ltp || 0) : safeParseFloat(pos.ltp || 0),
        low: stockInfo ? safeParseFloat(stockInfo.low || stockInfo.price || pos.ltp || 0) : safeParseFloat(pos.ltp || 0),
        prevClose: stockInfo ? safeParseFloat(stockInfo.prevClose || stockInfo.price || pos.close || pos.ltp || 0) : safeParseFloat(pos.close || pos.ltp || 0),
        change: stockInfo ? ((stockInfo.price >= (stockInfo.prevClose || stockInfo.price)) ? 'up' : 'down') : 'flat',
        depth: stockInfo ? stockInfo.depth : null
      };
    }
    
    const priceData = watchlistPrices[symbol];
    const ltp = priceData.ltp;
    
    // Header Symbol & Product badge
    const symbolEl = document.getElementById('bs-symbol');
    let prodTag = pos.producttype || 'INTRADAY';
    if (prodTag === 'MIS' || prodTag === 'Normal') prodTag = 'INTRADAY';
    if (prodTag === 'CNC' || prodTag === 'Delivery') prodTag = 'DELIVERY';
    
    const parsed = parseDisplaySymbol(symbol, cleanCompanyName(stockInfo.name), exchange);
    symbolEl.innerHTML = `${parsed.baseSymbol} <span class="badge" id="bs-product-badge" style="background: rgba(255,255,255,0.08); font-size: 11px; margin-left: 6px; padding: 2px 6px; border-radius: 4px; vertical-align: middle;">${prodTag}</span>`;
    
    // Company name
    document.getElementById('bs-company').textContent = `${parsed.subtitle} • ${parsed.exchange}`;
    
    // Update Price
    updateBSPrice(ltp, priceData.prevClose, priceData.change);
    
    // Stats
    document.getElementById('bs-stat-open').textContent = priceData.open.toFixed(2);
    document.getElementById('bs-stat-high').textContent = priceData.high.toFixed(2);
    document.getElementById('bs-stat-low').textContent = priceData.low.toFixed(2);
    document.getElementById('bs-stat-close').textContent = priceData.prevClose.toFixed(2);
    
    // Market Depth
    renderMarketDepth(ltp, priceData.depth);
    
    // Show Position actions row, hide watch star
    const posActions = document.getElementById('bs-position-actions');
    if (posActions) posActions.classList.remove('hidden');
    const starBtn = document.getElementById('bs-btn-star');
    if (starBtn) starBtn.classList.add('hidden'); // Hide star button for positions
    
    // Action buttons labels
    const buyBtn = document.getElementById('bs-btn-buy');
    const sellBtn = document.getElementById('bs-btn-sell');
    
    buyBtn.textContent = 'BUY MORE';
    buyBtn.className = 'btn btn-buy flex-1';
    buyBtn.onclick = () => {
      openOrderPlacement('BUY', stockInfo, ltp, false, 0, accountId, prodTag);
    };
    
    sellBtn.textContent = 'EXIT';
    sellBtn.className = 'btn btn-sell flex-1';
    
    // Exit side: if position qty > 0, we sell to exit. If qty < 0, we buy to exit.
    const exitSide = qty >= 0 ? 'SELL' : 'BUY';
    const absQty = Math.abs(qty);
    
    sellBtn.onclick = () => {
      openOrderPlacement(exitSide, stockInfo, ltp, true, absQty, accountId, prodTag);
    };
    
    // Show Modal
    const modal = document.getElementById('stock-details-modal');
    modal.classList.remove('hidden');
    
  } catch (err) {
    console.error('Error opening position details:', err);
  }
}

function updateBSPrice(ltp, prevClose, change) {
  const priceEl = document.getElementById('bs-price');
  const changeEl = document.getElementById('bs-change');
  if (!priceEl || !changeEl) return;
  
  priceEl.textContent = `₹${ltp.toFixed(2)}`;
  
  const actualPrevClose = prevClose || (ltp / 1.0164);
  const diff = ltp - actualPrevClose;
  const pct = actualPrevClose > 0 ? (diff / actualPrevClose) * 100 : 0;
  
  const isUp = ltp >= actualPrevClose;
  const trendClass = isUp ? 'text-green' : 'text-red';
  const sign = isUp ? '+' : '';
  
  changeEl.className = trendClass;
  changeEl.innerHTML = `${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
}

function renderMarketDepth(ltp, realDepth) {
  // Just use the live updater for initial render to maintain single source of truth
  updateBSMarketDepthPrices(ltp, realDepth);
}

function updateBSMarketDepthPrices(ltp, realDepth) {
  const container = document.getElementById('bs-depth-rows');
  if (!container) return;
  
  const bids = [];
  const asks = [];
  
  const hasRealDepth = realDepth && Array.isArray(realDepth.buy) && realDepth.buy.length > 0 &&
                       Array.isArray(realDepth.sell) && realDepth.sell.length > 0;
                       
  const symbol = currentSelectedStock ? currentSelectedStock.symbol : '';
  const isMcx = symbol.includes('CRUDEOIL') || symbol.includes('GOLD') || symbol.includes('SILVER') || symbol.includes('NATURALGAS') || symbol.includes('COPPER');
  const step = isMcx ? 1.00 : 0.05;
  
  if (hasRealDepth) {
    for (let i = 0; i < 5; i++) {
      const b = realDepth.buy[i] || { price: 0, quantity: 0 };
      const a = realDepth.sell[i] || { price: 0, quantity: 0 };
      bids.push({
        price: b.price || (ltp - (i + 1) * step),
        qty: b.quantity || 0
      });
      asks.push({
        price: a.price || (ltp + (i + 1) * step),
        qty: a.quantity || 0
      });
    }
  } else {
    // Stable, deterministic pseudo-depth fallback
    let hash = 0;
    for (let charIdx = 0; charIdx < symbol.length; charIdx++) {
      hash = symbol.charCodeAt(charIdx) + ((hash << 5) - hash);
    }
    
    const getBaseQty = (index, isBuy) => {
      const seed = Math.abs(hash + index * 17 + (isBuy ? 31 : 73));
      return 100 + (seed % 1400); // 100 to 1500
    };
    
    const ltpCents = Math.floor((ltp * 100) % 100) || 50;
    const getFluctuatedQty = (index, isBuy) => {
      const base = getBaseQty(index, isBuy);
      const fluctuationSeed = (ltpCents + index * 7 + (isBuy ? 13 : 29)) % 21; // 0 to 20
      const percent = (fluctuationSeed - 10) / 100; // -10% to +10%
      return Math.floor(base * (1 + percent));
    };
    
    for (let i = 0; i < 5; i++) {
      bids.push({
        price: ltp - (i + 1) * step,
        qty: getFluctuatedQty(i, true)
      });
      asks.push({
        price: ltp + (i + 1) * step,
        qty: getFluctuatedQty(i, false)
      });
    }
  }
  
  container.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const row = document.createElement('div');
    row.className = 'depth-row';
    
    const bidPriceText = bids[i].qty === 0 ? "₹0.00" : `₹${bids[i].price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const askPriceText = asks[i].qty === 0 ? "₹0.00" : `₹${asks[i].price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    row.innerHTML = `
      <span class="buy-qty">${bids[i].qty}</span>
      <span class="buy-price">${bidPriceText}</span>
      <span class="sell-price">${askPriceText}</span>
      <span class="sell-qty">${asks[i].qty}</span>
    `;
    container.appendChild(row);
  }
  
  // Get and fluctuate total quantities
  const totalBuyEl = document.getElementById('bs-depth-total-buy');
  const totalSellEl = document.getElementById('bs-depth-total-sell');
  
  let totalBuy = 0;
  let totalSell = 0;
  
  if (hasRealDepth) {
    totalBuy = realDepth.totalBuyQty || bids.reduce((sum, b) => sum + b.qty, 0);
    totalSell = realDepth.totalSellQty || asks.reduce((sum, a) => sum + a.qty, 0);
  } else {
    let baseBuy = 50000;
    let baseSell = 50000;
    let hash = 0;
    for (let charIdx = 0; charIdx < symbol.length; charIdx++) {
      hash = symbol.charCodeAt(charIdx) + ((hash << 5) - hash);
    }
    const seed = Math.abs(hash);
    baseBuy = 10000 + (seed % 80000);
    baseSell = 10000 + (seed % 75000);
    
    const ltpCents = Math.floor((ltp * 100) % 100) || 50;
    totalBuy = Math.floor(baseBuy * (1 + (ltpCents - 50) / 500));
    totalSell = Math.floor(baseSell * (1 + (49 - ltpCents) / 500));
  }
  
  if (totalBuyEl) totalBuyEl.textContent = totalBuy.toLocaleString('en-IN');
  if (totalSellEl) totalSellEl.textContent = totalSell.toLocaleString('en-IN');
}

function updateBSStarButton(symbol) {
  const btn = document.getElementById('bs-btn-star');
  if (!btn) return;
  
  const inWatchlist = watchlistSymbols.includes(symbol);
  if (inWatchlist) {
    btn.innerHTML = '<i class="fa-solid fa-star text-warning" style="color:var(--orange);"></i>';
  } else {
    btn.innerHTML = '<i class="fa-regular fa-star"></i>';
  }
}

async function toggleWatchlistStar() {
  if (!currentSelectedStock) return;
  const symbol = currentSelectedStock.symbol;
  const inWatchlist = watchlistSymbols.includes(symbol);
  
  if (inWatchlist) {
    await handleRemoveWatchlist(symbol);
  } else {
    if (watchlistSymbols.length >= 20) {
      showNotification("Watchlist limit reached (Max 20 symbols)", "error");
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, tab: currentWatchlistTab })
      });
      if (response.ok) {
        const res = await response.json();
        watchlistSymbols = res.watchlist;
        renderWatchlistTable();
        pollWatchlistPrices();
      }
    } catch (e) {
      console.error(e);
    }
  }
  updateBSStarButton(symbol);
}

// --- Order Placement Handlers ---

let currentOrderSide = 'BUY';
let currentOrderProduct = 'INTRADAY';
let currentOrderMode = 'LIMIT';
let currentOrderExchange = 'NSE';

function setOrderExchange(exchange) {
  if (isExitOrder) return; // Prevent changing exchange on exit
  currentOrderExchange = exchange;
  
  const nseEl = document.getElementById('order-exch-nse');
  const bseEl = document.getElementById('order-exch-bse');
  const nseDot = document.getElementById('order-nse-dot');
  const bseDot = document.getElementById('order-bse-dot');
  
  if (exchange === 'NSE') {
    if (nseEl) nseEl.className = 'active-exchange';
    if (bseEl) bseEl.className = '';
    if (nseDot) {
      nseDot.className = 'radio-dot';
      nseDot.style.background = currentOrderSide === 'BUY' ? 'var(--green)' : 'var(--red)';
    }
    if (bseDot) {
      bseDot.className = 'radio-dot empty';
      bseDot.style.background = 'transparent';
    }
  } else {
    if (nseEl) nseEl.className = '';
    if (bseEl) bseEl.className = 'active-exchange';
    if (nseDot) {
      nseDot.className = 'radio-dot empty';
      nseDot.style.background = 'transparent';
    }
    if (bseDot) {
      bseDot.className = 'radio-dot';
      bseDot.style.background = currentOrderSide === 'BUY' ? 'var(--green)' : 'var(--red)';
    }
  }
  
  if (currentSelectedStock) {
    const priceData = watchlistPrices[currentSelectedStock.symbol] || { ltp: currentSelectedStock.price };
    const price = exchange === 'NSE' ? priceData.ltp : priceData.ltp - 0.25;
    document.getElementById('order-price').value = price.toFixed(2);
  }
  
  calculateOrderMargin();
}

function openOrderPlacement(side, stockInfo, price, isExit = false, positionQty = 0, accountId = '', productType = '') {
  pushModalHistory('order-placement');
  currentOrderSide = side;
  currentSelectedStock = stockInfo;
  
  isExitOrder = isExit;
  exitPositionQty = positionQty;
  exitPositionAccount = accountId;
  exitPositionProduct = productType;

  // Disable elements in Exit Mode
  const productToggle = document.querySelector('.order-product-toggle');
  const exchangesToggle = document.querySelector('.order-exchanges');
  if (isExit) {
    if (productToggle) {
      productToggle.style.opacity = '0.5';
      productToggle.style.pointerEvents = 'none';
    }
    if (exchangesToggle) {
      exchangesToggle.style.opacity = '0.5';
      exchangesToggle.style.pointerEvents = 'none';
    }
  } else {
    if (productToggle) {
      productToggle.style.opacity = '1';
      productToggle.style.pointerEvents = 'auto';
    }
    if (exchangesToggle) {
      exchangesToggle.style.opacity = '1';
      exchangesToggle.style.pointerEvents = 'auto';
    }
  }

  // Populate Account selector
  const accSelect = document.getElementById('order-account-select');
  if (accSelect) {
    accSelect.innerHTML = '';
    
    const connectedAccounts = accounts.filter(acc => acc.connected === true);
    if (connectedAccounts.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No connected accounts available';
      accSelect.appendChild(opt);
    } else {
      const defaultSelectedId = isExit ? accountId : connectedAccounts[0].id;

      connectedAccounts.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        const brokerPretty = acc.broker === 'angel_one' ? 'Angel' : (acc.broker === 'dhan' ? 'Dhan' : 'Motilal');
        opt.textContent = `${acc.name} [${brokerPretty}]`;
        if (acc.id === defaultSelectedId) {
          opt.selected = true;
        }
        accSelect.appendChild(opt);
      });
      
      if (isExit) {
        accSelect.disabled = true; // Lock account selector on exit
      }
    }
  }
  
  // Update UI headers
  const parsedOrderSym = parseDisplaySymbol(stockInfo.symbol, stockInfo.name);
  document.getElementById('order-symbol').textContent = parsedOrderSym.baseSymbol;
  
  const parsedPrice = parseFloat(price) || 100.00;
  const priceData = watchlistPrices[stockInfo.symbol] || { ltp: parsedPrice, prevClose: parsedPrice };
  const prevClose = parseFloat(priceData.prevClose) || parsedPrice;
  const nsePrice = parseFloat(priceData.ltp) || parsedPrice;
  const bsePrice = nsePrice - 0.25;
  
  const diff = nsePrice - prevClose;
  const changePct = prevClose > 0 ? (diff / prevClose) * 100 : 0;
  
  document.getElementById('order-nse-price').textContent = `₹${nsePrice.toFixed(2)}`;
  document.getElementById('order-bse-price').textContent = `₹${bsePrice.toFixed(2)}`;
  
  const changeEl = document.getElementById('order-nse-change');
  if (changeEl) {
    const isUp = nsePrice >= prevClose;
    changeEl.className = isUp ? 'text-green' : 'text-red';
    changeEl.textContent = `(${isUp ? '+' : ''}${changePct.toFixed(2)}%)`;
  }
  
  // Set defaults
  document.getElementById('order-qty').value = isExit ? positionQty.toString() : '1';
  document.getElementById('order-price').value = nsePrice.toFixed(2);
  
  // Update max quantity label text
  const maxQtyLabel = document.querySelector('.max-qty');
  if (maxQtyLabel) {
    maxQtyLabel.innerHTML = isExit ? `Max Qty <span id="order-max-qty">${positionQty}</span>` : `Max Qty <span id="order-max-qty">999</span>`;
  }
  
  // Setup button styling based on side / exit mode
  const submitBtn = document.getElementById('btn-submit-order');
  if (submitBtn) {
    if (isExit) {
      submitBtn.textContent = 'EXIT';
      submitBtn.className = 'btn btn-order-submit btn-sell'; // Force red exit button
    } else {
      submitBtn.textContent = `PLACE ${side} ORDER`;
      submitBtn.className = `btn btn-order-submit ${side === 'BUY' ? 'btn-buy' : 'btn-sell'}`;
    }
  }
  
  // Set default product
  if (isExit) {
    // Force set product and styling
    currentOrderProduct = productType;
    const btnDelivery = document.getElementById('prod-delivery');
    const btnIntraday = document.getElementById('prod-intraday');
    const btnPaylater = document.getElementById('prod-paylater');
    if (btnDelivery) btnDelivery.className = 'product-btn';
    if (btnIntraday) btnIntraday.className = 'product-btn';
    if (btnPaylater) btnPaylater.className = 'product-btn';
    
    // Normalize mapping type for button selection
    let normalizedProd = productType === 'INTRADAY' || productType === 'MIS' || productType === 'Normal' ? 'INTRADAY' : 'DELIVERY';
    const activeBtn = normalizedProd === 'DELIVERY' ? btnDelivery : btnIntraday;
    if (activeBtn) {
      activeBtn.className = 'product-btn active';
      activeBtn.classList.add('sell-mode'); // red colored selection
    }
  } else {
    setProductType('INTRADAY');
  }
  
  // Set default price mode
  setPriceMode('LIMIT');
  
  // Set default exchange
  setOrderExchange('NSE');
  
  // Hide stock details modal directly without clearing currentSelectedStock
  const detailsModal = document.getElementById('stock-details-modal');
  if (detailsModal) detailsModal.classList.add('hidden');
  
  const modal = document.getElementById('order-placement-modal');
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => {
      const qtyInput = document.getElementById('order-qty');
      if (qtyInput) {
        qtyInput.value = isExit ? positionQty.toString() : '1';
        window.showKeypad(qtyInput);
      }
    }, 200);
  }
}

function closeOrderPlacement(preventPop) {
  const modal = document.getElementById('order-placement-modal');
  if (modal) modal.classList.add('hidden');
  
  // Re-enable select account dropdown
  const accSelect = document.getElementById('order-account-select');
  if (accSelect) accSelect.disabled = false;
  
  isExitOrder = false;
  exitPositionQty = 0;
  exitPositionAccount = '';
  exitPositionProduct = '';

  if (typeof window.hideKeypad === 'function') {
    window.hideKeypad();
  }

  if (!preventPop) {
    popModalHistory('order-placement');
  }
}

function backToStockDetails() {
  closeOrderPlacement();
  if (currentSelectedStock) {
    openStockDetails(currentSelectedStock.symbol);
  }
}

function setProductType(type) {
  if (isExitOrder) return; // Prevent changing product type on exit
  currentOrderProduct = type;
  
  const btnDelivery = document.getElementById('prod-delivery');
  const btnIntraday = document.getElementById('prod-intraday');
  const btnPaylater = document.getElementById('prod-paylater');
  
  if (btnDelivery) btnDelivery.className = 'product-btn';
  if (btnIntraday) btnIntraday.className = 'product-btn';
  if (btnPaylater) btnPaylater.className = 'product-btn';
  
  const activeBtn = type === 'DELIVERY' ? btnDelivery : (type === 'INTRADAY' ? btnIntraday : btnPaylater);
  if (activeBtn) {
    activeBtn.className = 'product-btn active';
    if (currentOrderSide === 'SELL') {
      activeBtn.classList.add('sell-mode');
    }
  }
  
  calculateOrderMargin();
}

function setPriceMode(mode) {
  currentOrderMode = mode;
  
  const btnLimit = document.getElementById('mode-limit');
  const btnMarket = document.getElementById('mode-market');
  const priceInput = document.getElementById('order-price');
  
  if (btnLimit) btnLimit.className = 'mode-btn';
  if (btnMarket) btnMarket.className = 'mode-btn';
  
  const activeBtn = mode === 'LIMIT' ? btnLimit : btnMarket;
  if (activeBtn) {
    activeBtn.className = 'mode-btn active';
    if (currentOrderSide === 'SELL') {
      activeBtn.classList.add('sell-mode');
    }
  }
  
  if (priceInput) {
    if (mode === 'MARKET') {
      priceInput.disabled = true;
      if (currentSelectedStock) {
        const priceData = watchlistPrices[currentSelectedStock.symbol] || { ltp: currentSelectedStock.price };
        const price = currentOrderExchange === 'NSE' ? priceData.ltp : priceData.ltp - 0.25;
        priceInput.value = price.toFixed(2);
      }
    } else {
      priceInput.disabled = false;
    }
  }
  
  calculateOrderMargin();
}

function adjustOrderPrice(amount) {
  if (currentOrderMode === 'MARKET') return;
  
  const priceInput = document.getElementById('order-price');
  if (!priceInput) return;
  
  let currentPrice = parseFloat(priceInput.value) || 0;
  currentPrice += amount;
  if (currentPrice < 0) currentPrice = 0;
  priceInput.value = currentPrice.toFixed(2);
  
  calculateOrderMargin();
}

function calculateOrderMargin() {
  const qtyInput = document.getElementById('order-qty');
  const priceInput = document.getElementById('order-price');
  const marginValEl = document.getElementById('order-margin-val');
  
  if (!qtyInput || !priceInput || !marginValEl) return;
  
  const qty = parseInt(qtyInput.value) || 0;
  const price = parseFloat(priceInput.value) || 0;
  
  let margin = qty * price;
  if (currentOrderProduct === 'INTRADAY') {
    margin = margin / 5; // 5x leverage
  }
  
  marginValEl.textContent = `₹${margin.toFixed(2)}`;
}

function toggleSmartOrders() {
  const content = document.getElementById('smart-content');
  const chevron = document.getElementById('smart-chevron');
  
  if (!content || !chevron) return;
  
  if (content.classList.contains('hidden')) {
    content.classList.remove('hidden');
    content.style.display = 'block';
    chevron.style.transform = 'rotate(180deg)';
  } else {
    content.classList.add('hidden');
    content.style.display = 'none';
    chevron.style.transform = 'rotate(0deg)';
  }
}

async function submitPlacedOrder() {
  const qtyInput = document.getElementById('order-qty');
  const priceInput = document.getElementById('order-price');
  
  if (!qtyInput || !priceInput) return;
  
  const qty = parseInt(qtyInput.value) || 0;
  if (qty <= 0) {
    alert('Please enter a valid quantity.');
    return;
  }
  
  const price = parseFloat(priceInput.value) || 0;
  if (currentOrderMode === 'LIMIT' && price <= 0) {
    alert('Please enter a valid limit price.');
    return;
  }
  
  const selectedAccId = document.getElementById('order-account-select').value;
  if (!selectedAccId) {
    alert('Please select an account.');
    return;
  }
  
  const selectedAcc = accounts.find(a => a.id === selectedAccId);
  if (!selectedAcc) {
    alert('Selected account not found.');
    return;
  }
  
  const submitBtn = document.getElementById('btn-submit-order');
  if (!submitBtn) return;
  
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Placing Order...';
  
  const payload = {
    accountId: selectedAccId,
    exchange: currentOrderExchange,
    tradingsymbol: currentSelectedStock.symbol,
    symboltoken: currentSelectedStock.token,
    producttype: currentOrderProduct === 'INTRADAY' ? 'INTRADAY' : (currentOrderProduct === 'PAY LATER' ? 'MARGIN' : 'DELIVERY'),
    transactiontype: currentOrderSide,
    quantity: qty,
    ordertype: currentOrderMode,
    price: currentOrderMode === 'LIMIT' ? price : 0
  };
  
  try {
    const response = await fetch(`${API_BASE}/execute-trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      const data = await response.json();
      
      closeOrderPlacement();
      
      // Reset button state immediately since modal is closed
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
      
      if (data.success === false) {
        showNotification(data.error || 'Unknown queue error', 'error');
      } else {
        showNotification('Order submitted to background execution queue!', 'success');
      }
      
      // Refresh details immediately
      setTimeout(() => {
        fetchLogs();
        populatePortfolioDropdown();
        refreshPortfolio();
      }, 300);
      
    } else {
      const err = await response.json();
      showNotification(`Order Placement Failed: ${err.error || 'Server error'}`, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  } catch (e) {
    showNotification('Failed to place order: Connection error.', 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

// --- Mobile Unified Orders / Positions Tab Switching ---
let ordersActiveMainTab = 'orders';
let ordersActiveSubTab = 'pending';

function setOrdersMainTab(tab) {
  ordersActiveMainTab = tab;
  
  const toggleOrders = document.getElementById('orders-toggle-orders');
  const togglePositions = document.getElementById('orders-toggle-positions');
  const subToggleBar = document.getElementById('orders-sub-toggle-bar');
  const accountSelectRow = document.getElementById('orders-account-select-container');
  
  const slider = document.getElementById('mobile-orders-positions-slider');
  
  if (toggleOrders) toggleOrders.classList.toggle('active', tab === 'orders');
  if (togglePositions) togglePositions.classList.toggle('active', tab === 'positions');
  
  if (tab === 'orders') {
    if (subToggleBar) subToggleBar.classList.remove('hidden');
    if (accountSelectRow) accountSelectRow.classList.remove('hidden');
    if (slider) slider.style.transform = 'translateX(0)';
    // Hide the global positions total bar when viewing orders list
    const posBar = document.getElementById('positions-total-fixed-bar');
    if (posBar) posBar.style.display = 'none';
    const posDetail = document.getElementById('positions-total-detail-drawer');
    if (posDetail) posDetail.style.display = 'none';
    setOrdersSubTab(ordersActiveSubTab);
  } else {
    if (subToggleBar) subToggleBar.classList.add('hidden');
    if (accountSelectRow) accountSelectRow.classList.remove('hidden');
    if (slider) slider.style.transform = 'translateX(-50%)';
    // Show the global positions total bar when on positions view
    const posBar = document.getElementById('positions-total-fixed-bar');
    if (posBar) posBar.style.display = 'flex';
    // Trigger relocation of positions card immediately
    relocateElements();
  }
}

function setOrdersSubTab(subTab) {
  ordersActiveSubTab = subTab;
  
  const btnPending = document.getElementById('orders-sub-pending');
  const btnExecuted = document.getElementById('orders-sub-executed');
  const btnRejected = document.getElementById('orders-sub-rejected');
  const btnCancelled = document.getElementById('orders-sub-cancelled');
  
  if (btnPending) btnPending.classList.toggle('active', subTab === 'pending');
  if (btnExecuted) btnExecuted.classList.toggle('active', subTab === 'executed');
  if (btnRejected) btnRejected.classList.toggle('active', subTab === 'rejected');
  if (btnCancelled) btnCancelled.classList.toggle('active', subTab === 'cancelled');
  
  renderMobileOrders();
}

function renderMobileOrders() {
  const container = document.getElementById('mobile-orders-list');
  if (!container) return;
  
  container.innerHTML = '';
  
  // Get active account info (need to check if it's Angel One or Motilal)
  const accountSelect = document.getElementById('orders-account-select');
  const accountId = accountSelect ? accountSelect.value : (document.getElementById('portfolio-account') ? document.getElementById('portfolio-account').value : '');
  
  if (!accountId) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 0;">Select an account to view orders.</div>`;
    return;
  }
  
  const acc = accounts.find(a => a.id === accountId);
  const isAngelOne = acc ? acc.broker === 'angel_one' : true;
  
  let filteredOrders = [];
  
  if (ordersActiveSubTab === 'pending') {
    filteredOrders = currentOrdersData.pending || [];
  } else {
    const executedList = currentOrdersData.executed || [];
    if (ordersActiveSubTab === 'executed') {
      filteredOrders = executedList.filter(o => {
        const status = (o.status || o.orderstatus || '').toLowerCase();
        return status === 'complete' || status === 'executed' || status === 'success' || status === 'filled' || status === 'traded';
      });
    } else if (ordersActiveSubTab === 'rejected') {
      filteredOrders = executedList.filter(o => {
        const status = (o.status || o.orderstatus || '').toLowerCase();
        return status === 'rejected' || status === 'failed' || status === 'error';
      });
    } else if (ordersActiveSubTab === 'cancelled') {
      filteredOrders = executedList.filter(o => {
        const status = (o.status || o.orderstatus || '').toLowerCase();
        return status === 'cancelled' || status === 'cancel';
      });
    }
  }
  
  if (filteredOrders.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 45px 12px; font-size: 14px;">No ${ordersActiveSubTab} orders found.</div>`;
    return;
  }
  
  filteredOrders.forEach(o => {
    const card = document.createElement('div');
    card.className = 'mobile-order-card';
    
    // Side styling (BUY = green, SELL = red)
    const side = (o.transactiontype || o.buyorsell || 'BUY').toUpperCase();
    const sideClass = side === 'BUY' ? 'buy' : 'sell';
    
    // Format quantity (e.g. "0/1" for pending, "1/1" for completed/executed)
    const qty = o.quantity || o.orderqty || 0;
    let qtyDisplay = '';
    if (ordersActiveSubTab === 'pending') {
      qtyDisplay = `0 / ${qty} Share`;
    } else if (ordersActiveSubTab === 'executed') {
      qtyDisplay = `${qty} / ${qty} Share`;
    } else {
      qtyDisplay = `0 / ${qty} Share`;
    }
    
    // Status Badge
    let statusBadgeClass = 'status-pending';
    if (ordersActiveSubTab === 'executed') statusBadgeClass = 'status-executed';
    else if (ordersActiveSubTab === 'rejected') statusBadgeClass = 'status-rejected';
    else if (ordersActiveSubTab === 'cancelled') statusBadgeClass = 'status-cancelled';
    
    // Price
    const priceVal = parseFloat(o.price || 0);
    
    // Time formatting
    const timeStr = o.updatetime || o.recordinserttime || '';
    
    // Badges: BUY/SELL, Product (INTRADAY -> INT, DELIVERY -> CNC), Order type (LIMIT/MARKET)
    let prodTag = o.producttype || 'INT';
    if (prodTag === 'INTRADAY' || prodTag === 'Normal' || prodTag === 'MIS') prodTag = 'INT';
    if (prodTag === 'DELIVERY' || prodTag === 'CNC' || prodTag === 'Delivery') prodTag = 'CNC';
    
    let orderTypeTag = o.ordertype || 'LMT';
    if (orderTypeTag === 'LIMIT') orderTypeTag = 'LMT';
    if (orderTypeTag === 'MARKET') orderTypeTag = 'MKT';
    
    // Dynamic LTP display from watchlist
    const symbolKey = o.tradingsymbol || o.symbol || '';
    const priceData = watchlistPrices[symbolKey];
    let ltpText = '';
    if (priceData && priceData.ltp) {
      const diff = priceData.ltp * 0.0164;
      const pct = 1.64;
      const sign = priceData.change === 'down' ? '-' : '+';
      const colorClass = priceData.change === 'down' ? 'text-red' : 'text-green';
      ltpText = `<span class="${colorClass}">LTP ₹${parseFloat(priceData.ltp).toFixed(2)} (${sign}${pct.toFixed(2)}%)</span>`;
    } else {
      ltpText = `<span style="color: var(--text-muted);">LTP ₹${parseFloat(priceVal).toFixed(2)}</span>`;
    }
    
    const displaySymbol = symbolKey.replace('-EQ', '');
    const displayStatus = o.status || o.orderstatus || ordersActiveSubTab;
    
    // Render card content
    let actionsHtml = '';
    if (ordersActiveSubTab === 'pending') {
      actionsHtml = `
        <div class="mobile-order-card-footer">
          <span class="mobile-order-card-time">${timeStr}</span>
          <div class="mobile-order-card-actions">
            <button class="mobile-order-card-btn edit" style="background: var(--blue); margin-right: 6px;" data-id="${o.orderid}">
              <i class="fa-solid fa-pen-to-square"></i> EDIT
            </button>
            <button class="mobile-order-card-btn cancel" data-id="${o.orderid}">
              <i class="fa-solid fa-xmark"></i> CANCEL
            </button>
          </div>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="mobile-order-card-footer">
          <span class="mobile-order-card-time">${timeStr}</span>
          <span class="mobile-order-card-time" style="color: var(--text-muted);">ID: ${o.orderid}</span>
        </div>
      `;
    }
    
    card.innerHTML = `
      <div class="mobile-order-card-header">
        <span class="mobile-order-card-sym">${displaySymbol}</span>
        <span class="mobile-order-card-price">₹${priceVal.toFixed(2)}</span>
      </div>
      <div class="mobile-order-card-middle">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <span>${qtyDisplay}</span>
          <div style="font-size: 11px;">${ltpText}</div>
        </div>
        <div class="mobile-order-card-badges">
          <span class="mobile-order-card-badge ${sideClass}">${side}</span>
          <span class="mobile-order-card-badge normal">${prodTag}</span>
          <span class="mobile-order-card-badge normal">${orderTypeTag}</span>
          <span class="mobile-order-card-badge ${statusBadgeClass}">${displayStatus}</span>
        </div>
      </div>
      ${actionsHtml}
    `;
    
    // Bind click handlers
    if (ordersActiveSubTab === 'pending') {
      const editBtn = card.querySelector('.mobile-order-card-btn.edit');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          handleModifyOrder(o, accountId);
        });
      }

      const cancelBtn = card.querySelector('.mobile-order-card-btn.cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
          if (confirm(`Cancel pending order ${o.orderid}?`)) {
            try {
              const res = await fetch(`${API_BASE}/orders/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId, orderId: o.orderid })
              });
              if (res.ok) {
                const resData = await res.json();
                if (resData.status === true || resData.status === 'SUCCESS' || resData.success === true) {
                  alert('Order cancelled successfully!');
                  refreshPortfolio();
                  fetchLogs();
                } else {
                  alert('Cancellation failed: ' + (resData.message || resData.error || 'Broker API error'));
                }
              } else {
                alert('Error cancelling order.');
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }
        });
      }
    }
    
    container.appendChild(card);
  });
}

// ==========================================================================
// Option Chain Controllers & Derivative Pricing
// ==========================================================================

let clickedOCSymbol = 'NIFTY';
let activeOCSymbol = 'NIFTY';
let activeOCSegment = 'LTP';
let activeOCExpiry = '25JUN26';
let ocPoller = null;

window.openOptionChain = function(symbol) {
  const cleanSymbol = symbol.replace('-EQ', '');
  clickedOCSymbol = cleanSymbol;
  activeOCSymbol = cleanSymbol;

  // Close stock details sheet
  closeStockDetails();
  
  // Set default expiry select value if element exists
  const expSelect = document.getElementById('oc-expiry-select');
  if (expSelect) {
    activeOCExpiry = expSelect.value;
  }
  
  // Populate strikes & prices
  refreshOptionChainTable();
  
  // Display Option Chain Modal
  const modal = document.getElementById('options-chain-modal');
  if (modal) modal.classList.remove('hidden');
  
  // Start Option Chain poller (refreshes prices every 2 seconds)
  if (ocPoller) clearInterval(ocPoller);
  ocPoller = setInterval(refreshOptionChainTable, 2000);
};

window.closeOptionChain = function() {
  const modal = document.getElementById('options-chain-modal');
  if (modal) modal.classList.add('hidden');
  
  if (ocPoller) {
    clearInterval(ocPoller);
    ocPoller = null;
  }
  
  // Re-open stock details
  if (currentSelectedStock) {
    openStockDetails(currentSelectedStock.symbol);
  }
};

window.setOCAsset = function(assetName) {
  activeOCSymbol = assetName;
  refreshOptionChainTable();
};

window.setOCSegment = function(segmentName) {
  activeOCSegment = segmentName;
  
  const tabs = ['ltp', 'oi', 'greeks'];
  tabs.forEach(t => {
    const btn = document.getElementById(`oc-segment-${t}`);
    if (btn) {
      if (t === segmentName.toLowerCase()) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });

  refreshOptionChainTable();
};

function renderOCHeaderToggles(activeSpotPrice) {
  const container = document.getElementById('oc-asset-selectors-container');
  if (!container) return;
  
  let firstAsset = clickedOCSymbol;
  let secondAsset = 'NIFTY';
  
  if (clickedOCSymbol === 'NIFTY') {
    firstAsset = 'NIFTY';
    secondAsset = 'BANKNIFTY';
  } else if (clickedOCSymbol === 'BANKNIFTY' || clickedOCSymbol === 'SENSEX') {
    firstAsset = clickedOCSymbol;
    secondAsset = 'NIFTY';
  }
  
  const niftySpot = parseFloat(document.getElementById('index-nifty-ltp')?.textContent.replace(/,/g, '')) || 23622.90;
  const sbilifeSpot = (watchlistPrices['SBILIFE-EQ'] && watchlistPrices['SBILIFE-EQ'].ltp) || 1706.00;
  
  const getSpotVal = (asset) => {
    if (asset === 'NIFTY') return niftySpot;
    if (asset === 'SBILIFE') return sbilifeSpot;
    if (asset === activeOCSymbol) return activeSpotPrice;
    
    const baseSym = asset + '-EQ';
    return (watchlistPrices[baseSym] && watchlistPrices[baseSym].ltp) || (watchlistPrices[asset] && watchlistPrices[asset].ltp) || 100.00;
  };
  
  const getChangeHTML = (asset, spot) => {
    let baseline = 100.00;
    const assetKey = asset.endsWith('-EQ') ? asset : `${asset}-EQ`;
    if (watchlistPrices[assetKey] && watchlistPrices[assetKey].prevClose) {
      baseline = watchlistPrices[assetKey].prevClose;
    } else {
      if (asset === 'NIFTY') baseline = 23622.90;
      else if (asset === 'BANKNIFTY') baseline = 51200.00;
      else if (asset === 'SENSEX') baseline = 75527.95;
      else if (asset === 'SBILIFE') baseline = 1706.00;
      else baseline = 100.00;
    }
    
    const diff = spot - baseline;
    const pct = (diff / baseline) * 100;
    const textClass = diff >= 0 ? 'text-green' : 'text-red';
    return `<span class="${textClass}" style="font-size: 9px; font-weight: 500;">${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
  };
  
  const firstSpot = getSpotVal(firstAsset);
  const secondSpot = getSpotVal(secondAsset);
  
  const firstActive = activeOCSymbol === firstAsset ? 'active' : '';
  const secondActive = activeOCSymbol === secondAsset ? 'active' : '';
  
  container.innerHTML = `
    <button class="oc-asset-btn ${firstActive}" onclick="setOCAsset('${firstAsset}')" style="flex: 1;">
      <div class="oc-asset-name">${firstAsset}</div>
      <div class="oc-asset-price-row">
        <span>${firstSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        ${getChangeHTML(firstAsset, firstSpot)}
      </div>
    </button>
    <button class="oc-asset-btn ${secondActive}" onclick="setOCAsset('${secondAsset}')" style="flex: 1;">
      <div class="oc-asset-name">${secondAsset} ${secondAsset === 'NIFTY' ? '<span class="oc-expiry-badge">Expiry Tue</span>' : ''}</div>
      <div class="oc-asset-price-row">
        <span>${secondSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        ${getChangeHTML(secondAsset, secondSpot)}
      </div>
    </button>
  `;
}

window.refreshOptionChainTable = async function() {
  if (!activeOCSymbol) return;
  
  try {
    const expSelect = document.getElementById('oc-expiry-select');
    if (expSelect) {
      activeOCExpiry = expSelect.value;
    }
    
    const url = `${API_BASE}/option-chain?symbol=${activeOCSymbol}&expiry=${activeOCExpiry}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch option chain.');
    const data = await response.json();
    
    const spotPrice = data.spotPrice;
    
    // Update Spot Spot display inside title block
    const spotDisplay = document.getElementById('oc-underlying-ltp');
    if (spotDisplay) spotDisplay.textContent = `₹${spotPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    // Render selectors
    renderOCHeaderToggles(spotPrice);
    
    const tbody = document.getElementById('oc-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    let separatorInserted = false;
    
    data.chain.forEach(row => {
      if (!separatorInserted && row.strike > spotPrice) {
        insertSpotSeparatorRow(tbody, spotPrice, activeOCSymbol);
        separatorInserted = true;
      }
      
      const tr = document.createElement('tr');
      
      // Determine columns based on segment selection
      let callLtpText = `₹${row.calls.ltp.toFixed(2)}`;
      let putLtpText = `₹${row.puts.ltp.toFixed(2)}`;
      let callSubText = `<div class="oc-change-pct text-green">+${row.calls.changePct.toFixed(2)}%</div>`;
      let putSubText = `<div class="oc-change-pct text-red">${row.puts.changePct.toFixed(2)}%</div>`;
      
      if (activeOCSegment === 'OI') {
        callLtpText = row.calls.oi;
        putLtpText = row.puts.oi;
        callSubText = `<div class="oc-change-pct text-muted">OI (Qty)</div>`;
        putSubText = `<div class="oc-change-pct text-muted">OI (Qty)</div>`;
      } else if (activeOCSegment === 'Greeks') {
        callLtpText = `Δ ${row.calls.greeks.delta.toFixed(2)}`;
        putLtpText = `Δ ${row.puts.greeks.delta.toFixed(2)}`;
        callSubText = `<div class="oc-change-pct text-muted" style="font-size:8px;">θ ${row.calls.greeks.theta.toFixed(2)} | γ ${row.calls.greeks.gamma.toFixed(4)}</div>`;
        putSubText = `<div class="oc-change-pct text-muted" style="font-size:8px;">θ ${row.puts.greeks.theta.toFixed(2)} | γ ${row.puts.greeks.gamma.toFixed(4)}</div>`;
      }
      
      const callItmClass = row.calls.itm ? 'call-itm' : '';
      const putItmClass = row.puts.itm ? 'put-itm' : '';
      
      tr.innerHTML = `
        <td class="call-cell ${callItmClass} oc-volume-val" onclick="placeDerivativeOrder('${row.calls.symbol}', 'BUY', ${row.calls.ltp})">${row.calls.volume}</td>
        
        <td class="call-cell ${callItmClass}" onclick="placeDerivativeOrder('${row.calls.symbol}', 'BUY', ${row.calls.ltp})">
          <div class="oc-ltp-val call-side" style="font-weight: 700;">${callLtpText}</div>
          ${callSubText}
        </td>
        
        <td class="oc-strike-col" style="font-weight: 700; color: var(--text-primary);">${row.strike}</td>
        
        <td class="put-cell ${putItmClass}" onclick="placeDerivativeOrder('${row.puts.symbol}', 'BUY', ${row.puts.ltp})">
          <div class="oc-ltp-val put-side" style="font-weight: 700; color: #f2495c;">${putLtpText}</div>
          ${putSubText}
        </td>
  
        <td class="put-cell ${putItmClass} oc-volume-val" onclick="placeDerivativeOrder('${row.puts.symbol}', 'BUY', ${row.puts.ltp})">${row.puts.volume}</td>
      `;
      
      tbody.appendChild(tr);
    });
    
    if (!separatorInserted) {
      insertSpotSeparatorRow(tbody, spotPrice, activeOCSymbol);
    }
  } catch (err) {
    console.error('Error refreshing option chain table:', err);
  }
};

function insertSpotSeparatorRow(tbody, spotPrice, asset) {
  const spotRow = document.createElement('tr');
  spotRow.className = 'oc-spot-separator-row';
  
  const assetKey = asset.endsWith('-EQ') ? asset : `${asset}-EQ`;
  let baseline = 100.00;
  if (watchlistPrices[assetKey] && watchlistPrices[assetKey].prevClose) {
    baseline = watchlistPrices[assetKey].prevClose;
  } else {
    const isNifty = asset === 'NIFTY';
    baseline = isNifty ? 23622.90 : (asset === 'BANKNIFTY' ? 51200.00 : (asset === 'SENSEX' ? 75527.95 : (asset === 'SBILIFE' ? 1706.00 : 100.00)));
  }
  const diff = spotPrice - baseline;
  const pct = (diff / baseline) * 100;
  
  const displayVal = `${diff >= 0 ? '+' : ''}${diff.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  const displayClass = diff >= 0 ? "text-green" : "text-red";
  const displayArrow = diff >= 0 ? "▲" : "▼";

  spotRow.innerHTML = `
    <td colspan="5" style="padding: 10px; text-align: center; font-weight: 600; font-size: 12.5px;">
      Long Buildup &nbsp;|&nbsp; 
      <span style="color: var(--text-primary); font-family:var(--font-mono); font-weight:700;">${spotPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> 
      &nbsp;&nbsp;<span class="${displayClass}">${displayArrow} ${displayVal}</span>
    </td>
  `;
  tbody.appendChild(spotRow);
}

window.placeDerivativeOrder = function(optionSymbol, side, ltp) {
  // Clear option chain poller and close modal
  if (ocPoller) {
    clearInterval(ocPoller);
    ocPoller = null;
  }
  const ocModal = document.getElementById('options-chain-modal');
  if (ocModal) ocModal.classList.add('hidden');
  
  // Construct mock stockInfo for the option contract
  const stockInfo = {
    symbol: optionSymbol,
    name: optionSymbol.replace(/-/g, ' '),
    token: 'opt_' + Math.random().toString(36).substring(2, 9),
    price: ltp
  };
  
  // Open the standard order placement modal for this option contract!
  openOrderPlacement(side, stockInfo, ltp);
};

// ==========================================================================
// Pull to Refresh Touch Gesture Controller (Mobile Pull Down)
// ==========================================================================

let touchStartY = 0;
let touchMoveY = 0;
let isPulling = false;

window.setupPullToRefresh = function() {
  const contentArea = document.querySelector('.content-area');
  const indicator = document.getElementById('pull-refresh-indicator');
  const icon = document.querySelector('.pull-refresh-icon');
  const text = document.querySelector('.pull-refresh-text');
  const circle = document.querySelector('.pull-refresh-circle');
  
  if (!contentArea || !indicator || !circle || !text || !icon) return;

  // Track touches on document.body to support pull-down on any active view
  document.body.addEventListener('touchstart', (e) => {
    const startY = e.touches[0].clientY;
    // Only trigger if touch starts within the top 1 inch (e.g., 96px) of the viewport
    if (contentArea.scrollTop === 0 && !isPulling && startY <= 96) {
      touchStartY = startY;
      isPulling = true;
      indicator.style.transition = 'none';
    }
  }, { passive: true });

  document.body.addEventListener('touchmove', (e) => {
    if (!isPulling) return;
    
    const currentY = e.touches[0].clientY;
    const diff = currentY - touchStartY;

    if (diff > 0) {
      const pullDistance = Math.min(diff * 0.35, 75);
      touchMoveY = pullDistance;

      indicator.style.transform = `translateY(${pullDistance}px)`;
      contentArea.style.transform = `translateY(${pullDistance}px)`;
      contentArea.style.transition = 'none';

      icon.style.transform = `rotate(${pullDistance * 4.5}deg)`;

      if (pullDistance >= 55) {
        text.textContent = 'Release to refresh';
        circle.style.borderColor = 'var(--cyan)';
      } else {
        text.textContent = 'Swipe down to refresh';
        circle.style.borderColor = 'rgba(255, 255, 255, 0.15)';
      }
    }
  }, { passive: true });

  document.body.addEventListener('touchend', () => {
    if (!isPulling) return;
    isPulling = false;

    indicator.style.transition = 'transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
    contentArea.style.transition = 'transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)';

    if (touchMoveY >= 55) {
      text.textContent = 'Refreshing data...';
      circle.classList.add('refreshing');
      
      indicator.style.transform = 'translateY(55px)';
      contentArea.style.transform = 'translateY(55px)';

      Promise.all([
        loadData(),
        refreshPortfolio()
      ]).then(() => {
        setTimeout(() => {
          text.textContent = 'Refreshed!';
          setTimeout(() => {
            indicator.style.transform = 'translateY(0)';
            contentArea.style.transform = 'translateY(0)';
            setTimeout(() => {
              circle.classList.remove('refreshing');
              text.textContent = 'Swipe down to refresh';
            }, 350);
          }, 300);
        }, 700);
      }).catch(() => {
        indicator.style.transform = 'translateY(0)';
        contentArea.style.transform = 'translateY(0)';
        circle.classList.remove('refreshing');
      });
    } else {
      indicator.style.transform = 'translateY(0)';
      contentArea.style.transform = 'translateY(0)';
    }
    
    touchMoveY = 0;
  });
};

// ==========================================================================
// Custom Lightweight Candlestick Chart Engine (TradingView Style)
// ==========================================================================

let chartActiveStockInfo = null;
let lwChartObj = null;
let lwCandleSeries = null;
let activeChartSymbol = null;

let chartSideToolbarHidden = true;

window.openTradingViewChart = async function(symbol, customName = null, customPrice = null, customToken = null) {
  if (currentSelectedStock && currentSelectedStock.symbol === symbol) {
    chartActiveStockInfo = { ...currentSelectedStock };
  } else {
    const baseSym = symbol.includes('-') ? symbol : `${symbol}-EQ`;
    const priceData = watchlistPrices[baseSym] || watchlistPrices[symbol];
    const priceVal = priceData ? priceData.ltp : (customPrice || 100.00);
    
    chartActiveStockInfo = {
      symbol: symbol,
      name: customName || symbol.replace(/-/g, ' '),
      price: priceVal,
      token: customToken || 'opt_' + Math.random().toString(36).substring(2, 9)
    };
  }

  // Update compact header badges dynamically
  const headerSymbol = document.getElementById('chart-header-symbol');
  const headerPrice = document.getElementById('chart-header-price');
  if (headerSymbol) {
    headerSymbol.textContent = symbol.toUpperCase().replace('-EQ', '');
  }
  if (headerPrice) {
    headerPrice.textContent = `₹${chartActiveStockInfo.price.toFixed(2)}`;
  }
  const headerNifty = document.getElementById('chart-header-nifty');
  if (headerNifty && watchlistPrices['NIFTY-EQ']) {
    headerNifty.textContent = watchlistPrices['NIFTY-EQ'].ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  closeStockDetails();
  
  const modal = document.getElementById('chart-modal');
  if (modal) modal.classList.remove('hidden');
  
  activeChartSymbol = symbol;
  renderTradingViewWidget();
};

function renderTradingViewWidget() {
  const container = document.getElementById('tradingview-widget-container');
  if (container) {
    // Retain the toggle button, only clear and rebuild the tv-chart-widget-inner div
    let inner = document.getElementById('tv-chart-widget-inner');
    if (!inner) {
      inner = document.createElement('div');
      inner.id = 'tv-chart-widget-inner';
      inner.style.height = '100%';
      inner.style.width = '100%';
      container.appendChild(inner);
    }
    inner.innerHTML = '';
  }

  const toggleBtn = document.getElementById('chart-toolbar-toggle');
  const toggleIcon = document.getElementById('chart-toolbar-toggle-icon');
  
  if (toggleBtn && toggleIcon) {
    if (chartSideToolbarHidden) {
      toggleBtn.style.left = '0px';
      toggleIcon.className = 'fa-solid fa-chevron-right';
    } else {
      toggleBtn.style.left = '43px'; // Sit exactly on the edge of the 43px side toolbar
      toggleIcon.className = 'fa-solid fa-chevron-left';
    }
  }
  
  const cleanSymbol = activeChartSymbol.toUpperCase().replace('-EQ', '');
  const parts = cleanSymbol.split('-');
  const underlying = parts[0];
  
  // Use BSE exchange for equity symbols to avoid "This symbol is only available on TradingView" error on local IPs.
  let tvSymbol = `BSE:${underlying}`;
  if (underlying === 'NIFTY' || underlying === 'BANKNIFTY') {
    tvSymbol = `NSE:${underlying}`;
  } else if (underlying === 'SENSEX') {
    tvSymbol = 'BSE:SENSEX';
  }

  if (typeof TradingView !== 'undefined') {
    new TradingView.widget({
      "width": "100%",
      "height": "100%",
      "symbol": tvSymbol,
      "interval": "D",
      "timezone": "Asia/Kolkata",
      "theme": "dark",
      "style": "1",
      "locale": "en",
      "enable_publishing": false,
      "hide_side_toolbar": chartSideToolbarHidden,
      "hide_top_toolbar": false,
      "hide_legend": false,
      "allow_symbol_change": true,
      "container_id": "tv-chart-widget-inner",
      "withdateranges": true,
      "show_popup_button": true,
      "popup_width": "1000",
      "popup_height": "650",
      "supported_resolutions": ["1", "3", "5", "15", "30", "60", "120", "240", "D", "W"],
      "studies": []
    });
  } else {
    const inner = document.getElementById('tv-chart-widget-inner');
    if (inner) {
      inner.innerHTML = '<div style="color: var(--text-primary); text-align: center; padding-top: 150px;">Chart library loading...</div>';
    }
    setTimeout(renderTradingViewWidget, 500);
  }
}

window.toggleChartSidebar = function() {
  chartSideToolbarHidden = !chartSideToolbarHidden;
  renderTradingViewWidget();
};

function renderLwCandleChart(candles) {
  const inner = document.getElementById('tv-chart-widget-inner');
  if (!inner) return;
  
  if (typeof LightweightCharts === 'undefined') {
    inner.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding-top: 150px;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 32px; color: var(--cyan); margin-bottom: 12px;"></i>
      <p>Loading charting libraries...</p>
    </div>`;
    setTimeout(() => renderLwCandleChart(candles), 500);
    return;
  }
  
  inner.innerHTML = '';
  
  lwChartObj = LightweightCharts.createChart(inner, {
    layout: {
      backgroundColor: '#faf6ed',
      textColor: '#57534e',
      fontSize: 11,
      fontFamily: 'Outfit, sans-serif'
    },
    grid: {
      vertLines: { color: 'rgba(140, 133, 123, 0.06)' },
      horzLines: { color: 'rgba(140, 133, 123, 0.06)' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    rightPriceScale: { borderColor: 'rgba(140, 133, 123, 0.1)',
      visible: true
    },
    timeScale: { borderColor: 'rgba(140, 133, 123, 0.1)',
      timeVisible: true,
      secondsVisible: false
    }
  });
  
  lwCandleSeries = lwChartObj.addCandlestickSeries({
    upColor: '#10b981',
    downColor: '#f43f5e',
    borderDownColor: '#f43f5e',
    borderUpColor: '#10b981',
    wickDownColor: '#f43f5e',
    wickUpColor: '#10b981',
  });
  
  const dataPoints = candles.map(c => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  })).sort((a, b) => a.time - b.time);
  
  lwCandleSeries.setData(dataPoints);
  lwChartObj.timeScale().fitContent();
  
  const resizeObserver = new ResizeObserver(entries => {
    if (entries.length === 0 || !lwChartObj) return;
    const { width, height } = entries[0].contentRect;
    lwChartObj.resize(width, height);
  });
  resizeObserver.observe(inner);
}

window.updateLwChartLiveTick = function(symbol, price) {
  if (activeChartSymbol === symbol && lwCandleSeries && lwChartObj) {
    const now = Math.floor(Date.now() / 1000);
    
    lwCandleSeries.update({
      time: now,
      open: price,
      high: Math.max(price, chartActiveStockInfo.lastHigh || price),
      low: Math.min(price, chartActiveStockInfo.lastLow || price),
      close: price
    });
    
    chartActiveStockInfo.lastHigh = Math.max(price, chartActiveStockInfo.lastHigh || price);
    chartActiveStockInfo.lastLow = Math.min(price, chartActiveStockInfo.lastLow || price);
  }
};

window.submitChartOrder = function(side) {
  if (!chartActiveStockInfo) return;
  
  closeChartModal();
  
  openOrderPlacement(side, chartActiveStockInfo, chartActiveStockInfo.price);
};

window.closeChartModal = function() {
  const modal = document.getElementById('chart-modal');
  if (modal) modal.classList.add('hidden');
  const container = document.getElementById('tradingview-widget-container');
  if (container) container.innerHTML = '';
  
  lwChartObj = null;
  lwCandleSeries = null;
  activeChartSymbol = null;
  
  if (currentSelectedStock && currentSelectedStock.symbol === chartActiveStockInfo.symbol) {
    openStockDetails(currentSelectedStock.symbol);
  }
};

// ==========================================================================
// In-App Custom Numeric Keypad Controller
// ==========================================================================

let activeKeypadInput = null;

window.pressKeypad = function(key) {
  if (!activeKeypadInput) return;
  
  let currentVal = activeKeypadInput.value || '';
  
  if (key === 'BACKSPACE') {
    activeKeypadInput.value = currentVal.substring(0, currentVal.length - 1);
  } else {
    // Prevent decimal entry for share quantity input
    if (key === '.' && activeKeypadInput.id === 'order-qty') {
      return;
    }
    // If the input is currently empty and the user types '.', add a '0' before it
    if (key === '.' && currentVal === '') {
      activeKeypadInput.value = '0.';
    } else if (key === '.' && currentVal.includes('.')) {
      // Prevent multiple decimals
      return;
    } else {
      activeKeypadInput.value = currentVal + key;
    }
  }
  
  // Trigger oninput manually to update margin calculation
  activeKeypadInput.dispatchEvent(new Event('input'));
};

window.pressBest5 = function() {
  // Toggle the Accordion of Smart Orders or just show visual confirmation
  const smartContent = document.getElementById('smart-content');
  if (smartContent) {
    toggleSmartOrders();
  }
  // Show a nice confirmation in console
  fetchLogs();
};

window.showKeypad = function(inputEl) {
  activeKeypadInput = inputEl;
  
  const keypad = document.getElementById('custom-numeric-keypad');
  if (keypad) {
    keypad.classList.remove('hidden');
  }

  const sheetContent = document.querySelector('#order-placement-modal .bottom-sheet-content');
  if (sheetContent) {
    sheetContent.classList.add('keypad-active');
  }
  
  // Highlight the active input visually
  const qtyInputEl = document.getElementById('order-qty');
  const priceInputEl = document.getElementById('order-price');
  if (qtyInputEl) qtyInputEl.style.borderColor = 'var(--border-color)';
  if (priceInputEl) priceInputEl.style.borderColor = 'var(--border-color)';
  
  if (inputEl) {
    inputEl.style.borderColor = '#4ebbb0';
    inputEl.focus();
    
    // Position cursor at the end
    setTimeout(() => {
      inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
    }, 50);
  }
};

window.hideKeypad = function() {
  const keypad = document.getElementById('custom-numeric-keypad');
  if (keypad) {
    keypad.classList.add('hidden');
  }

  const sheetContent = document.querySelector('#order-placement-modal .bottom-sheet-content');
  if (sheetContent) {
    sheetContent.classList.remove('keypad-active');
  }
  
  const qtyInputEl = document.getElementById('order-qty');
  const priceInputEl = document.getElementById('order-price');
  if (qtyInputEl) qtyInputEl.style.borderColor = 'var(--border-color)';
  if (priceInputEl) priceInputEl.style.borderColor = 'var(--border-color)';
  activeKeypadInput = null;
};

// Setup click and focus handlers for Custom Keypad
function initCustomKeypadEvents() {
  const qtyInput = document.getElementById('order-qty');
  const priceInput = document.getElementById('order-price');
  
  if (qtyInput) {
    qtyInput.addEventListener('click', (e) => {
      e.preventDefault();
      window.showKeypad(qtyInput);
    });
    qtyInput.addEventListener('focus', (e) => {
      e.preventDefault();
      window.showKeypad(qtyInput);
    });
  }
  
  if (priceInput) {
    priceInput.addEventListener('click', (e) => {
      e.preventDefault();
      window.showKeypad(priceInput);
    });
    priceInput.addEventListener('focus', (e) => {
      e.preventDefault();
      window.showKeypad(priceInput);
    });
  }
}

// Call initialization once loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCustomKeypadEvents);
} else {
  initCustomKeypadEvents();
}

// Render Mobile Holdings cards with summary card
function renderMobileHoldings(holdings, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!holdings || holdings.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 30px 0;">
        <i class="fa-solid fa-vault" style="font-size: 24px; margin-bottom: 8px; display: block; color: rgba(140,133,123,0.12);"></i>
        No holdings found.
      </div>
    `;
    return;
  }

  const listContainer = document.createElement('div');
  listContainer.className = 'mobile-holdings-list-content';
  listContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';

  let totalInvested = 0;
  let totalCurrent = 0;
  let totalPnl = 0;

  holdings.forEach(hold => {
    const symbol = hold.tradingsymbol || hold.scripname || 'N/A';
    const exchange = hold.exchange || 'NSE';
    const qty = parseFloat(hold.quantity || hold.dpquantity || 0);
    const avgPrice = parseFloat(hold.averageprice || hold.buyavgprice || 0);
    const ltp = getLiveOrStaticLtp(hold);
    const currentValue = qty * ltp;
    const investedValue = qty * avgPrice;
    
    const pnl = currentValue - investedValue;
    
    totalInvested += investedValue;
    totalCurrent += currentValue;
    totalPnl += pnl;

    const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
    const pnlSign = pnl >= 0 ? '+' : '-';
    const pnlText = `${pnlSign}₹${Math.abs(pnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const closeVal = getLiveOrStaticPrevClose(hold);
    const changePct = closeVal > 0 ? ((ltp - closeVal) / closeVal) * 100 : 0;
    const changeSign = changePct >= 0 ? '+' : '';
    const changeClass = changePct >= 0 ? 'text-green' : 'text-red';
    const changePctText = `(${changeSign}${changePct.toFixed(2)}%)`;

    const card = document.createElement('div');
    card.className = 'mobile-pos-card mobile-holding-card';

    const displayName = symbol.replace('-EQ', '');

    card.innerHTML = `
      <div class="mobile-pos-card-header">
        <span class="mobile-pos-card-sym">${displayName}</span>
        <span id="mob-hold-pnl-${symbol}" class="mobile-pos-card-pnl ${pnlClass}">${pnlText}</span>
      </div>
      <div class="mobile-pos-card-middle">
        <div class="mobile-pos-card-qty-avg">
          <span>${qty} Shares</span>
          <span style="color:rgba(140,133,123,0.18);">|</span>
          <span>Avg. ₹${avgPrice.toFixed(2)}</span>
        </div>
        <div class="mobile-pos-card-ltp">
          LTP <span id="mob-hold-ltp-${symbol}">₹${ltp.toFixed(2)}</span> <span id="mob-hold-chg-${symbol}" class="${changeClass}" style="font-weight: 500; font-size:11px;">${changePctText}</span>
        </div>
      </div>
      <div class="mobile-pos-card-footer" style="display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed rgba(255, 255, 255, 0.06); padding-top: 8px; margin-top: 2px;">
        <div class="mobile-pos-card-badges">
          <span class="mobile-pos-badge normal" style="background: rgba(217, 119, 6, 0.12); color: #d97706;">HLD</span>
          <span class="mobile-pos-badge normal">${exchange}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-secondary); text-align: right;">
          Invested ₹${investedValue.toFixed(2)} &bull; Current <span id="mob-hold-val-${symbol}">₹${currentValue.toFixed(2)}</span>
        </div>
      </div>
    `;

    listContainer.appendChild(card);
  });

  const isPnlPositive = totalPnl >= 0;
  const holdingsPnlClass = isPnlPositive ? 'text-green' : 'text-red';
  const holdingsPnlSign = isPnlPositive ? '+' : '-';
  const holdingsPnlText = `${holdingsPnlSign}₹${Math.abs(totalPnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  const totalChangePct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const totalChangeSign = totalChangePct >= 0 ? '+' : '';
  const totalChangeClass = totalChangePct >= 0 ? 'text-green' : 'text-red';

  const summaryCard = document.createElement('div');
  summaryCard.className = 'mobile-pos-card';
  summaryCard.style.cssText = 'background: rgba(255, 255, 255, 0.04); border: 1.5px solid var(--border-color); margin-top: 4px; padding: 12px 14px;';
  summaryCard.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed rgba(255, 255, 255, 0.06); padding-bottom: 8px; margin-bottom: 8px;">
      <span style="font-weight: 700; font-size: 13px; color: var(--text-primary);">Demat Holdings Summary</span>
      <span id="mob-holdings-total-pnl" class="${holdingsPnlClass}" style="font-weight: 700; font-size: 14px;">${holdingsPnlText}</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">
      <span>Total Investment</span>
      <span id="mob-holdings-total-inv" style="font-family: var(--font-mono); font-weight: 600; color: var(--text-primary);">₹${totalInvested.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">
      <span>Current Value</span>
      <span id="mob-holdings-total-val" style="font-family: var(--font-mono); font-weight: 600; color: var(--text-primary);">₹${totalCurrent.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-secondary);">
      <span>Overall Return</span>
      <span id="mob-holdings-total-return" class="${totalChangeClass}" style="font-family: var(--font-mono); font-weight: 700;">${totalChangeSign}${totalChangePct.toFixed(2)}%</span>
    </div>
  `;

  container.appendChild(listContainer);
  container.appendChild(summaryCard);
}

// Render Mobile Orders inside Portfolio tab portals
function renderMobileOrdersList(orders, containerId, isPending = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!orders || orders.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 20px 0;">
        No ${isPending ? 'pending' : 'executed'} orders.
      </div>
    `;
    return;
  }

  const listContainer = document.createElement('div');
  listContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';

  orders.forEach(o => {
    const card = document.createElement('div');
    card.className = 'mobile-order-card';
    
    const side = (o.transactiontype || o.buyorsell || 'BUY').toUpperCase();
    const sideClass = side === 'BUY' ? 'buy' : 'sell';
    
    const qty = o.quantity || o.orderqty || 0;
    const qtyDisplay = isPending ? `0 / ${qty} Share` : `${qty} / ${qty} Share`;
    
    let statusBadgeClass = 'status-pending';
    if (!isPending) {
      const status = (o.status || o.orderstatus || '').toLowerCase();
      if (status === 'complete' || status === 'executed' || status === 'success' || status === 'filled' || status === 'traded') statusBadgeClass = 'status-executed';
      else if (status === 'rejected' || status === 'failed' || status === 'error') statusBadgeClass = 'status-rejected';
      else if (status === 'cancelled' || status === 'cancel') statusBadgeClass = 'status-cancelled';
    }
    
    const priceVal = parseFloat(o.price || 0);
    const timeStr = o.updatetime || o.recordinserttime || '';
    
    let prodTag = o.producttype || 'INT';
    if (prodTag === 'INTRADAY' || prodTag === 'Normal' || prodTag === 'MIS') prodTag = 'INT';
    if (prodTag === 'DELIVERY' || prodTag === 'CNC' || prodTag === 'Delivery') prodTag = 'CNC';
    
    let orderTypeTag = o.ordertype || 'LMT';
    if (orderTypeTag === 'LIMIT') orderTypeTag = 'LMT';
    if (orderTypeTag === 'MARKET') orderTypeTag = 'MKT';
    
    const symbolKey = o.tradingsymbol || o.symbol || '';
    const priceData = watchlistPrices[symbolKey];
    let ltpText = '';
    if (priceData && priceData.ltp) {
      const diff = priceData.ltp * 0.0164;
      const pct = 1.64;
      const sign = priceData.change === 'down' ? '-' : '+';
      const colorClass = priceData.change === 'down' ? 'text-red' : 'text-green';
      ltpText = `<span class="${colorClass}">LTP ₹${parseFloat(priceData.ltp).toFixed(2)} (${sign}${pct.toFixed(2)}%)</span>`;
    } else {
      ltpText = `<span style="color: var(--text-muted);">LTP ₹${priceVal.toFixed(2)}</span>`;
    }
    
    const displaySymbol = symbolKey.replace('-EQ', '');
    const displayStatus = o.status || o.orderstatus || (isPending ? 'PENDING' : 'EXECUTED');
    
    let actionsHtml = '';
    if (isPending) {
      actionsHtml = `
        <div class="mobile-order-card-footer">
          <span class="mobile-order-card-time">${timeStr}</span>
          <div class="mobile-order-card-actions">
            <button class="mobile-order-card-btn edit" style="background: var(--blue); margin-right: 6px;" data-id="${o.orderid}">
              <i class="fa-solid fa-pen-to-square"></i> EDIT
            </button>
            <button class="mobile-order-card-btn cancel" data-id="${o.orderid}">
              <i class="fa-solid fa-xmark"></i> CANCEL
            </button>
          </div>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="mobile-order-card-footer">
          <span class="mobile-order-card-time">${timeStr}</span>
          <span class="mobile-order-card-time" style="color: var(--text-muted);">ID: ${o.orderid}</span>
        </div>
      `;
    }
    
    card.innerHTML = `
      <div class="mobile-order-card-header">
        <span class="mobile-order-card-sym">${displaySymbol}</span>
        <span class="mobile-order-card-price">₹${priceVal.toFixed(2)}</span>
      </div>
      <div class="mobile-order-card-middle">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <span>${qtyDisplay}</span>
          <div style="font-size: 11px;">${ltpText}</div>
        </div>
        <div class="mobile-order-card-badges">
          <span class="mobile-order-card-badge ${sideClass}">${side}</span>
          <span class="mobile-order-card-badge normal">${prodTag}</span>
          <span class="mobile-order-card-badge normal">${orderTypeTag}</span>
          <span class="mobile-order-card-badge ${statusBadgeClass}">${displayStatus}</span>
        </div>
      </div>
      ${actionsHtml}
    `;
    
    if (isPending) {
      const editBtn = card.querySelector('.mobile-order-card-btn.edit');
      const cancelBtn = card.querySelector('.mobile-order-card-btn.cancel');
      const accountSelect = document.getElementById('portfolio-account');
      const accountId = accountSelect ? accountSelect.value : '';

      if (editBtn) {
        editBtn.addEventListener('click', () => {
          handleModifyOrder(o, accountId);
        });
      }
      if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
          if (confirm(`Cancel pending order ${o.orderid}?`)) {
            try {
              const res = await fetch(`${API_BASE}/orders/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId, orderId: o.orderid })
              });
              if (res.ok) {
                const resData = await res.json();
                if (resData.status === true || resData.status === 'SUCCESS' || resData.success === true) {
                  alert('Order cancelled successfully!');
                  refreshPortfolio();
                  fetchLogs();
                } else {
                  alert('Cancellation failed: ' + (resData.message || resData.error || 'Broker API error'));
                }
              } else {
                alert('Error cancelling order.');
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }
        });
      }
    }
    
    listContainer.appendChild(card);
  });
  
  container.appendChild(listContainer);
}

// Render Mobile positions with custom card styling matching Angel One screenshot
function renderMobilePositions(positions, containerId, accountId = '') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const oldList = container.querySelector('.mobile-positions-list-content');
  const savedScrollTop = oldList ? oldList.scrollTop : 0;

  container.innerHTML = '';

  // Configure absolute positioning parameters on the parent container if it's mobile positions list
  if (containerId === 'mobile-positions-container') {
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
  }

  // Create list container for cards
  const listContainer = document.createElement('div');
  listContainer.className = 'mobile-positions-list-content';
  if (containerId === 'mobile-positions-container') {
    listContainer.style.cssText = 'flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-bottom: 160px; box-sizing: border-box;';
  } else {
    listContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
  }

  let totalPnl = 0;
  let totalRealised = 0;
  let totalUnrealised = 0;

  if (!positions || positions.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 40px 0;">
        <i class="fa-solid fa-folder-open" style="font-size: 24px; margin-bottom: 8px; display: block; color: rgba(140,133,123,0.12);"></i>
        No open positions found.
      </div>
    `;
  } else {
    positions.forEach(pos => {
      const qty = pos.netqty !== undefined ? safeParseFloat(pos.netqty) : (pos.buyquantity !== undefined && pos.sellquantity !== undefined ? safeParseFloat(pos.buyquantity) - safeParseFloat(pos.sellquantity) : safeParseFloat(pos.buyquantity || 0));
      const avgPrice = getPositionAvgPrice(pos);
      const ltp = safeParseFloat(pos.ltp || 0);
      const lotSize = parseInt(pos.lotsize || 1);
      
      const pnl = calculatePositionPnl(pos);
      
      totalPnl += pnl;
      if (qty === 0) {
        totalRealised += pnl;
      } else {
        totalUnrealised += pnl;
      }

      let isBuy = qty > 0;
      if (qty === 0) {
        // For closed positions, check the oldest executed order for this symbol to find entry direction
        const symbolOrders = currentOrdersData && Array.isArray(currentOrdersData.executed)
          ? currentOrdersData.executed.filter(o => (o.tradingsymbol || o.symbol || '').toUpperCase() === (pos.tradingsymbol || pos.symbol || '').toUpperCase())
          : [];
        if (symbolOrders.length > 0) {
          const entryOrder = symbolOrders[symbolOrders.length - 1];
          isBuy = entryOrder.transactiontype.toUpperCase() === 'BUY';
        } else {
          isBuy = true; // Default fallback
        }
      } else if (qty < 0) {
        isBuy = false;
      }

      const txBadgeClass = isBuy ? 'buy' : 'sell';
      const txBadgeText = isBuy ? 'BUY' : 'SELL';

      // Format Quantity and Lots
      const lotsCount = lotSize > 1 ? Math.round(Math.abs(qty) / lotSize) : Math.abs(qty);
      const qtyLabel = lotSize > 1 
        ? (lotsCount === 1 ? '1 Lot' : `${lotsCount} Lots`) 
        : (lotsCount === 1 ? '1 Share' : `${lotsCount} Shares`);
      const qtyPrefix = qty < 0 ? '-' : '';
      const qtyDisplayText = `${qtyPrefix}${qtyLabel}`;

      // Format PNL
      const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
      const pnlSign = pnl >= 0 ? '+' : '-';
      const pnlText = `${pnlSign}₹${Math.abs(pnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      // Format LTP & Pct Change
      const closeVal = parseFloat(pos.close || 0);
      const changePct = closeVal > 0 ? ((ltp - closeVal) / closeVal) * 100 : 0;
      const changeSign = changePct >= 0 ? '+' : '';
      const changeClass = changePct >= 0 ? 'text-green' : 'text-red';
      const changePctText = `(${changeSign}${changePct.toFixed(2)}%)`;

      // Badges: INT vs CF
      let prodTag = pos.producttype || 'CF';
      if (prodTag === 'INTRADAY' || prodTag === 'MIS' || prodTag === 'Normal') prodTag = 'INT';
      else prodTag = 'CF';

      const card = document.createElement('div');
      card.className = 'mobile-pos-card' + (qty === 0 ? ' position-closed' : '');

      // Parse symbol name to look like screenshot if possible
      let displayName = pos.tradingsymbol || pos.symbol || 'N/A';
      const optMatch = displayName.match(/^([A-Z]+)(\d{2}[A-Z]{3}\d{2})(\d+)(PE|CE)$/);
      if (optMatch) {
        const name = optMatch[1];
        const dateRaw = optMatch[2]; // e.g. 16JUN26
        const strike = optMatch[3];
        const optType = optMatch[4];
        
        const dateFormatted = dateRaw.substring(0, 2) + '-' + dateRaw.substring(2, 5).toLowerCase().replace(/^\w/, c => c.toUpperCase()) + '-' + dateRaw.substring(5);
        displayName = `${name} ${dateFormatted} ${strike} ${optType}`;
      } else {
        const futMatch = displayName.match(/^([A-Z\d]+)(\d{2}[A-Z]{3}\d{2})FUT$/);
        if (futMatch) {
          const name = futMatch[1];
          const dateRaw = futMatch[2];
          const dateFormatted = dateRaw.substring(0, 2) + '-' + dateRaw.substring(2, 5).toLowerCase().replace(/^\w/, c => c.toUpperCase()) + '-' + dateRaw.substring(5);
          displayName = `${name} ${dateFormatted} FUT`;
        }
      }

      if (qty === 0) {
        // Closed position layout matching user image
        const closedQty = safeParseFloat(pos.buyquantity || pos.buyqty || pos.sellquantity || pos.sellqty || 0);
        const closedLotsCount = lotSize > 1 ? Math.round(closedQty / lotSize) : closedQty;
        const closedQtyLabel = lotSize > 1 
          ? (closedLotsCount === 1 ? '1 Lot' : `${closedLotsCount} Lots`) 
          : (closedLotsCount === 1 ? '1 Share' : `${closedLotsCount} Shares`);

        const buyAvg = safeParseFloat(pos.buyavgprice || pos.buyAvgPrice || pos.buyprice || pos.averageprice || 0);
        const sellAvg = safeParseFloat(pos.sellavgprice || pos.sellAvgPrice || pos.sellprice || 0);

        card.innerHTML = `
          <div class="mobile-pos-card-header">
            <span class="mobile-pos-card-sym">${displayName}</span>
            <span class="mobile-pos-card-pnl ${pnlClass}">${pnlText}</span>
          </div>
          <div class="mobile-pos-card-middle">
            <div class="mobile-pos-card-qty-avg" style="font-weight: 500;">
              <span>${closedQtyLabel} &bull; ${prodTag}</span>
            </div>
            <div class="mobile-pos-card-ltp">
              LTP ₹${ltp.toFixed(2)} <span class="${changeClass}" style="font-weight: 500; font-size:11px;">${changePctText}</span>
            </div>
          </div>
          <div class="mobile-pos-card-footer" style="display: flex; justify-content: space-between; align-items: center; border-top: none; padding-top: 0; margin-top: 0;">
            <div style="font-size: 12px; color: var(--text-secondary);">
              Buy ₹${buyAvg.toFixed(2)}
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); text-align: right;">
              Sell ₹${sellAvg.toFixed(2)}
            </div>
          </div>
        `;
      } else {
        // Active position layout
        card.innerHTML = `
          <div class="mobile-pos-card-header">
            <span class="mobile-pos-card-sym">${displayName}</span>
            <span class="mobile-pos-card-pnl ${pnlClass}">${pnlText}</span>
          </div>
          <div class="mobile-pos-card-middle">
            <div class="mobile-pos-card-qty-avg">
              <span>${qtyDisplayText}</span>
              <span style="color:rgba(140,133,123,0.18);">|</span>
              <span>Avg. ₹${avgPrice.toFixed(2)}</span>
            </div>
            <div class="mobile-pos-card-ltp">
              LTP ₹${ltp.toFixed(2)} <span class="${changeClass}" style="font-weight: 500; font-size:11px;">${changePctText}</span>
            </div>
          </div>
          <div class="mobile-pos-card-footer">
            <div class="mobile-pos-card-badges">
              <span class="mobile-pos-badge ${txBadgeClass}">${txBadgeText}</span>
              <span class="mobile-pos-badge normal">${prodTag}</span>
              ${lotSize > 1 ? `<span class="mobile-pos-badge normal">(1 Lot = ${lotSize})</span>` : ''}
            </div>
          </div>
        `;
      }

      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        openPositionDetails(pos, accountId);
      });
      listContainer.appendChild(card);
    });
  }

  // Render sticky summary footer
  const isTotalPositive = totalPnl >= 0;
  const totalPnlText = `${isTotalPositive ? '+' : '-'}₹${Math.abs(totalPnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const footerBg = isTotalPositive ? '#E6F4EA' : '#FCE8E6';
  const footerBorder = isTotalPositive ? '#C4EAD0' : '#fad2cf';
  const textColor = '#1F2937';
  const iconColor = isTotalPositive ? '#137333' : '#c5221f';

  // ─── mobile-positions-container: use a GLOBAL FIXED bar at body level ───
  // position:fixed breaks inside CSS-transformed ancestors (the orders slider uses translateX)
  // So we render this bar directly on document.body — outside any transform context
  if (containerId === 'mobile-positions-container') {
    container.appendChild(listContainer);
    if (savedScrollTop > 0) {
      listContainer.scrollTop = savedScrollTop;
    }
    updatePositionsTotalBar(totalPnl, totalPnlText, totalRealised, totalUnrealised, footerBg, footerBorder, textColor, iconColor);
    return;
  }

  // ─── For other containers (mobile-portfolio-positions-portal) ───
  const summaryFooter = document.createElement('div');
  summaryFooter.className = 'mobile-pos-summary-footer';
  summaryFooter.id = `${containerId}-summary-footer`;

  summaryFooter.style.background = footerBg;
  summaryFooter.style.borderTop = `1px solid ${footerBorder}`;
  summaryFooter.style.color = textColor;

  summaryFooter.innerHTML = `
    <div class="mobile-pos-summary-title">
      <span class="fa-stack" style="font-size: 8px; margin-right: 4px; vertical-align: middle; width: 2.2em; height: 2.2em; line-height: 2.2em;">
        <i class="fa-solid fa-circle fa-stack-2x" style="color: ${iconColor};"></i>
        <i class="fa-solid fa-check fa-stack-1x" style="color: var(--text-primary)fff; font-weight: 900; font-size: 11px;"></i>
      </span>
      <span style="font-weight: 500; color: ${textColor};">Total</span>
    </div>
    <div class="mobile-pos-summary-pnl" style="color: ${textColor};">
      <span>${totalPnlText}</span>
      <i class="fa-solid fa-chevron-up" id="${containerId}-chevron" style="font-size: 11px; margin-left: 6px; transition: transform 0.2s; color: ${textColor};"></i>
    </div>
  `;

  const detailDrawer = document.createElement('div');
  detailDrawer.id = `${containerId}-detail-drawer`;
  detailDrawer.className = 'hidden';
  detailDrawer.style.cssText = `
    position: relative;
    background: #252233;
    border-top: 1px dashed rgba(255, 255, 255, 0.08);
    padding: 10px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    z-index: 99;
    border-radius: 0;
  `;

  detailDrawer.innerHTML = `
    <div style="display:flex; justify-content:space-between;">
      <span>Realized P&L:</span>
      <span class="${totalRealised >= 0 ? 'text-green' : 'text-red'}">${totalRealised >= 0 ? '+' : '-'}₹${Math.abs(totalRealised).toFixed(2)}</span>
    </div>
    <div style="display:flex; justify-content:space-between;">
      <span>Unrealized P&L:</span>
      <span class="${totalUnrealised >= 0 ? 'text-green' : 'text-red'}">${totalUnrealised >= 0 ? '+' : '-'}₹${Math.abs(totalUnrealised).toFixed(2)}</span>
    </div>
  `;

  let expanded = false;
  summaryFooter.addEventListener('click', () => {
    expanded = !expanded;
    if (expanded) {
      detailDrawer.classList.remove('hidden');
      const chevron = document.getElementById(`${containerId}-chevron`);
      if (chevron) chevron.style.transform = 'rotate(180deg)';
    } else {
      detailDrawer.classList.add('hidden');
      const chevron = document.getElementById(`${containerId}-chevron`);
      if (chevron) chevron.style.transform = 'rotate(0deg)';
    }
  });

  container.appendChild(listContainer);
  if (savedScrollTop > 0) {
    listContainer.scrollTop = savedScrollTop;
  }

  if (containerId === 'mobile-portfolio-positions-portal' && (!positions || positions.length === 0)) {
    return;
  }

  container.appendChild(detailDrawer);
  container.appendChild(summaryFooter);
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Fixed Total P&L Bar (body level — avoids CSS transform stacking issue)
// Shows above mobile bottom nav (68px) when user is on Positions sub-tab
// ─────────────────────────────────────────────────────────────────────────────
function updatePositionsTotalBar(totalPnl, totalPnlText, totalRealised, totalUnrealised, footerBg, footerBorder, textColor, iconColor) {
  let globalBar = document.getElementById('positions-total-fixed-bar');
  let detailDrwr = document.getElementById('positions-total-detail-drawer');

  if (!globalBar) {
    globalBar = document.createElement('div');
    globalBar.id = 'positions-total-fixed-bar';
    document.body.appendChild(globalBar);
  }

  if (!detailDrwr) {
    detailDrwr = document.createElement('div');
    detailDrwr.id = 'positions-total-detail-drawer';
    document.body.appendChild(detailDrwr);
  }

  // ── Main bar: fixed above mobile bottom nav (68px) ──
  globalBar.style.cssText = `
    position: fixed;
    bottom: 68px;
    left: 0;
    right: 0;
    z-index: 9998;
    background: ${footerBg};
    border-top: 2px solid ${footerBorder};
    color: ${textColor};
    padding: 13px 16px;
    display: none;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.3);
  `;

  const chevronRotation = positionsTotalBarExpanded ? 'rotate(180deg)' : 'rotate(0deg)';

  globalBar.innerHTML = `
    <div style="display:flex; align-items:center; gap:6px;">
      <span class="fa-stack" style="font-size: 9px; vertical-align: middle; width: 2em; height: 2em; line-height: 2em;">
        <i class="fa-solid fa-circle fa-stack-2x" style="color: ${iconColor};"></i>
        <i class="fa-solid fa-check fa-stack-1x" style="color: var(--text-primary)fff; font-weight: 900;"></i>
      </span>
      <span style="font-weight: 600; font-size: 15px; color: ${textColor};">Total</span>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <span style="font-weight: 700; font-size: 17px; color: ${textColor};">${totalPnlText}</span>
      <i class="fa-solid fa-chevron-up" id="positions-total-chevron" style="font-size: 13px; transition: transform 0.25s; color: ${textColor}; transform: ${chevronRotation};"></i>
    </div>
  `;

  // ── Detail drawer: slides up above the bar when expanded ──
  const drawerDisplay = positionsTotalBarExpanded ? 'flex' : 'none';
  const barH = globalBar.offsetHeight || 48;
  const drawerBottom = positionsTotalBarExpanded ? `${68 + barH}px` : '';

  detailDrwr.style.cssText = `
    position: fixed;
    bottom: ${drawerBottom};
    left: 0;
    right: 0;
    z-index: 9997;
    background: #1c1a2e;
    border-top: 1px dashed rgba(255,255,255,0.12);
    padding: 12px 16px;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
    display: ${drawerDisplay};
  `;

  detailDrwr.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span>Realized P&L</span>
      <span style="font-weight:700;" class="${totalRealised >= 0 ? 'text-green' : 'text-red'}">${totalRealised >= 0 ? '+' : '-'}₹${Math.abs(totalRealised).toFixed(2)}</span>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span>Unrealized P&L</span>
      <span style="font-weight:700;" class="${totalUnrealised >= 0 ? 'text-green' : 'text-red'}">${totalUnrealised >= 0 ? '+' : '-'}₹${Math.abs(totalUnrealised).toFixed(2)}</span>
    </div>
  `;

  // ── Toggle expand/collapse ──
  globalBar.onclick = () => {
    positionsTotalBarExpanded = !positionsTotalBarExpanded;
    const chevron = document.getElementById('positions-total-chevron');
    if (positionsTotalBarExpanded) {
      const currentBarH = globalBar.offsetHeight || 48;
      detailDrwr.style.bottom = (68 + currentBarH) + 'px';
      detailDrwr.style.display = 'flex';
      if (chevron) chevron.style.transform = 'rotate(180deg)';
    } else {
      detailDrwr.style.display = 'none';
      if (chevron) chevron.style.transform = 'rotate(0deg)';
    }
  };

  // ── Show immediately if orders tab + positions sub-tab is active ──
  const ordersTab = document.getElementById('tab-orders');
  const slider = document.getElementById('mobile-orders-positions-slider');
  if (ordersTab && ordersTab.classList.contains('active') &&
      slider && slider.style.transform === 'translateX(-50%)') {
    globalBar.style.display = 'flex';
    if (positionsTotalBarExpanded) {
      setTimeout(() => {
        const currentBarH = globalBar.offsetHeight || 48;
        detailDrwr.style.bottom = (68 + currentBarH) + 'px';
      }, 0);
    }
  }
}

function initSwipeNavigation() {
  let touchStartX = 0;
  let touchStartY = 0;
  let touchEndX = 0;
  let touchEndY = 0;

  const minSwipeDistance = 50; // pixels
  const maxVerticalOffset = 45; // pixels

  const handleGesture = () => {
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    if (Math.abs(deltaX) > minSwipeDistance && Math.abs(deltaY) < maxVerticalOffset) {
      if (deltaX > 0) {
        // Left-to-Right swipe (finger moves right) -> Go from Position to Order
        if (activeTab === 'orders' && ordersActiveMainTab === 'positions') {
          setOrdersMainTab('orders');
        } else if (activeTab === 'portfolio') {
          switchTab('orders');
        }
      } else {
        // Right-to-Left swipe (finger moves left) -> Go from Order to Position
        if (activeTab === 'orders' && ordersActiveMainTab === 'orders') {
          setOrdersMainTab('positions');
        } else if (activeTab === 'orders') {
          switchTab('portfolio');
        }
      }
    }
  };

  document.addEventListener('touchstart', e => {
    if (e.target.closest('.content-area') || e.target.closest('.tab-content')) {
      touchStartX = e.changedTouches[0].screenX;
      touchStartY = e.changedTouches[0].screenY;
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (e.target.closest('.content-area') || e.target.closest('.tab-content')) {
      touchEndX = e.changedTouches[0].screenX;
      touchEndY = e.changedTouches[0].screenY;
      handleGesture();
    }
  }, { passive: true });
}

function initBottomSheetSwipeDismiss() {
  const sheets = [
    { id: 'stock-details-modal', closeFn: () => closeStockDetails() },
    { id: 'order-placement-modal', closeFn: () => closeOrderPlacement() },
    { id: 'options-chain-modal', closeFn: () => closeOptionChain() }
  ];

  sheets.forEach(({ id, closeFn }) => {
    const modal = document.getElementById(id);
    if (!modal) return;
    const content = modal.querySelector('.bottom-sheet-content');
    const dragHandle = modal.querySelector('.bottom-sheet-drag-handle');
    if (!content || !dragHandle) return;

    let startY = 0;
    let currentY = 0;
    let isDragging = false;
    let startFromHandle = false;

    // Helper to check if any container under touch is scrolled down
    const isScrolledDown = (el) => {
      let curr = el;
      while (curr && curr !== content) {
        if (curr.scrollHeight > curr.clientHeight && curr.scrollTop > 0) {
          return true;
        }
        curr = curr.parentElement;
      }
      return false;
    };

    content.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        startY = e.touches[0].clientY;
        currentY = startY;
        // If touched drag handle, its child, or header, start dragging immediately
        startFromHandle = dragHandle.contains(e.target) || e.target.closest('.stock-details-header') || e.target.closest('.bottom-sheet-drag-handle');
        if (startFromHandle) {
          isDragging = true;
          content.style.transition = 'none';
        } else {
          isDragging = false;
        }
      }
    }, { passive: true });

    content.addEventListener('touchmove', (e) => {
      if (!e.touches || !e.touches[0]) return;
      currentY = e.touches[0].clientY;
      const diff = currentY - startY;

      // If we didn't start from the handle, activate dragging down if pulling down and not inside active scrollable containers
      if (!startFromHandle && !isDragging) {
        if (diff > 5 && !isScrolledDown(e.target)) {
          isDragging = true;
          content.style.transition = 'none';
        }
      }

      if (isDragging && diff > 0) {
        if (e.cancelable) {
          e.preventDefault();
        }
        content.style.transform = `translateY(${diff}px)`;
      }
    }, { passive: false }); // passive: false is necessary to call e.preventDefault() on drag

    content.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      startFromHandle = false;
      content.style.transition = '';
      
      const diff = currentY - startY;
      if (diff > 120) {
        closeFn();
      }
      content.style.transform = '';
    });
  });
}


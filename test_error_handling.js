function simulateError(error) {
  const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
  console.log('ErrorMsg:', errorMsg);
  
  const isRateLimitError = error.response && (
    error.response.status === 429 ||
    errorMsg.toLowerCase().includes('rate') ||
    errorMsg.toLowerCase().includes('limit') ||
    errorMsg.toLowerCase().includes('exceed')
  );
  
  const isAuthError = error.response && !isRateLimitError && (
    error.response.status === 401 || 
    error.response.status === 403 || 
    errorMsg.toLowerCase().includes('token') ||
    errorMsg.toLowerCase().includes('session')
  );
  
  console.log('isRateLimitError:', !!isRateLimitError);
  console.log('isAuthError:', !!isAuthError);
}

console.log('--- Test case 1: Standard Axios 403 with exceeding rate message ---');
simulateError({
  response: {
    status: 403,
    data: "Access denied because of exceeding access rate"
  }
});

console.log('\n--- Test case 2: String error message without response object ---');
simulateError({
  message: "Access denied because of exceeding access rate"
});

console.log('\n--- Test case 3: Empty status with rate limit string ---');
simulateError({
  response: {
    data: "Access denied because of exceeding access rate"
  }
});

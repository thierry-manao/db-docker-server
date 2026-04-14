const loginForm = document.querySelector('#login-form');
const loginMessage = document.querySelector('#login-message');

function setLoginMessage(text, isError = false) {
    loginMessage.textContent = text;
    loginMessage.className = `alert mt-4 mb-0 ${isError ? 'alert-danger' : 'alert-info'}`;
}

async function loginRequest(path, options = {}) {
    const response = await fetch(path, {
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
        credentials: 'same-origin',
        ...options,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || 'La requête a échoué.');
    }

    return payload;
}

(async () => {
    try {
        await loginRequest('/api/auth/session');
        window.location.replace('/');
    } catch (error) {
        setLoginMessage('Entrez les identifiants admin pour continuer.');
    }
})();

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(loginForm);
    const username = String(formData.get('username') || '').trim();
    const password = String(formData.get('password') || '');

    try {
        setLoginMessage('Connexion en cours...');
        await loginRequest('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        window.location.replace('/');
    } catch (error) {
        setLoginMessage(error.message, true);
    }
});

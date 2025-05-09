const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	// Configuration variables
	let savedFrequency = null;
	let savedBranch = null;
	let timerInterval = null;
	let timerRunning = false;
	let currentNotification = null;
	
	// CONFIGURATION: Change this to true for production mode (minutes instead of seconds)
	const PRODUCTION_MODE = true;
	// Time multiplier - 1000 for seconds, 60000 for minutes
	const TIME_MULTIPLIER = PRODUCTION_MODE ? 60000 : 1000;
	// Time unit label for display
	const TIME_UNIT = PRODUCTION_MODE ? 'm' : 's';

	// Status bar items
	const commitStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	commitStatusBarItem.text = "$(git-commit) Commit";
	commitStatusBarItem.tooltip = "Ask to commit";
	commitStatusBarItem.command = "first.askCommit";
	commitStatusBarItem.show();

	const timerStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
	timerStatusBarItem.text = "$(clock) Timer: Off";
	timerStatusBarItem.tooltip = "Auto-commit timer status";
	timerStatusBarItem.show();

	const outputChannel = vscode.window.createOutputChannel("First Extension");

	// Execute git commands in terminal
	async function executeGitCommand(commands) {
		// Get the current workspace folder
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder is open");
		}
		const cwd = workspaceFolders[0].uri.fsPath;
		
		let results = [];
		
		// Execute each command programmatically and collect results
		for (const command of commands) {
			try {
				outputChannel.appendLine(`Executing: ${command}`);
				const { stdout, stderr } = await execPromise(command, { cwd });
				results.push({ success: true, command, stdout, stderr });
				outputChannel.appendLine(`Result: ${stdout}`);
			} catch (error) {
				outputChannel.appendLine(`Error executing "${command}": ${error.message}`);
				results.push({ success: false, command, error: error.message });
				throw new Error(`Command failed: ${command}\nError: ${error.message}`);
			}
		}
		
		return results;
	}

	// Start the auto-commit timer
	function startTimer() {
		if (timerRunning || !savedFrequency) return;
		
		// Convert frequency using the configured multiplier
		const intervalMs = parseInt(savedFrequency) * TIME_MULTIPLIER;
		
		timerRunning = true;
		timerStatusBarItem.text = `$(clock) Timer: ${savedFrequency}${TIME_UNIT}`;
		
		outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Timer started: ${savedFrequency} ${TIME_UNIT}`);
		
		timerInterval = setInterval(() => {
			// Show the notification and store the reference
			currentNotification = vscode.window.showInformationMessage(
				'Do you want to commit your changes?',
				{ modal: false },
				'Commit+Push',
				'Commit',
				'Skip'
			);
			
			// Handle the notification response
			currentNotification.then(selection => {
				if (selection === 'Commit' || selection === 'Commit+Push') {
					// Directly ask for commit message without additional confirmation
					getCommitMessageAndExecute(selection);
				}
				currentNotification = null;
			});
		}, intervalMs);
	}

	// Stop the auto-commit timer
	function stopTimer() {
		if (!timerRunning) return;
		
		clearInterval(timerInterval);
		timerRunning = false;
		timerStatusBarItem.text = "$(clock) Timer: Off";
		
		// Dismiss any active notification when stopping the timer
		if (currentNotification) {
			currentNotification.dispose();
			currentNotification = null;
		}
		
		outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Timer stopped`);
	}

	// Improved branch handling with better error reporting
// Improved branch handling with better error reporting
async function handleBranch(branchName) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		throw new Error("No workspace folder is open");
	}
	const cwd = workspaceFolders[0].uri.fsPath;

	try {
		// First check if the repository is initialized
		await execPromise('git rev-parse --is-inside-work-tree', { cwd });
	} catch (error) {
		throw new Error("Not a git repository. Please initialize git first with 'git init'");
	}

	try {
		// Get current branch
		const { stdout: currentBranch } = await execPromise('git rev-parse --abbrev-ref HEAD', { cwd });
		outputChannel.appendLine(`Current branch: ${currentBranch.trim()}`);

		// Check if the target branch exists locally
		try {
			await execPromise(`git show-ref --verify --quiet refs/heads/${branchName}`, { cwd });
			// Branch exists locally
			outputChannel.appendLine(`Branch ${branchName} exists locally`);

			// If we're not on the target branch, check it out
			if (currentBranch.trim() !== branchName) {
				// Check for uncommitted changes
				const { stdout: status } = await execPromise('git status --porcelain', { cwd });
				if (status.trim() !== '') {
					await execPromise('git stash', { cwd });
					outputChannel.appendLine('Uncommitted changes stashed');
				}

				await execPromise(`git checkout ${branchName}`, { cwd });
				outputChannel.appendLine(`Checked out branch: ${branchName}`);

				if (status.trim() !== '') {
					await execPromise('git stash pop', { cwd });
					outputChannel.appendLine('Stashed changes reapplied');
				}
			}
		} catch (error) {
			// Branch doesn't exist locally
			outputChannel.appendLine(`Branch ${branchName} does not exist locally`);

			// Check if branch exists on remote
			try {
				await execPromise(`git show-ref --verify --quiet refs/remotes/origin/${branchName}`, { cwd });
				outputChannel.appendLine(`Branch ${branchName} exists on remote`);

				await execPromise(`git checkout -b ${branchName} --track origin/${branchName}`, { cwd });
				outputChannel.appendLine(`Created and checked out branch ${branchName} tracking remote`);
			} catch (remoteError) {
				// Branch doesn't exist remotely either, try local existence check again before creating
				outputChannel.appendLine(`Branch ${branchName} does not exist remotely, checking local before creating`);

				try {
					await execPromise(`git show-ref --verify --quiet refs/heads/${branchName}`, { cwd });
					outputChannel.appendLine(`Branch ${branchName} already exists locally, checking out`);
					await execPromise(`git checkout ${branchName}`, { cwd });
				} catch {
					await execPromise(`git checkout -b ${branchName}`, { cwd });
					outputChannel.appendLine(`Created and checked out new branch: ${branchName}`);
				}
			}
		}

		return true;
	} catch (error) {
		outputChannel.appendLine(`Error handling branch ${branchName}: ${error.message}`);
		throw new Error(`Error handling branch ${branchName}: ${error.message}`);
	}
}


	// Function to get commit message and execute the git commands
	async function getCommitMessageAndExecute(selectionType) {
		const commitMessage = await vscode.window.showInputBox({
			placeHolder: 'Enter commit message',
			prompt: 'Type your commit message and press Enter',
			validateInput: text => {
				return text.trim() === '' ? 'Commit message cannot be empty' : null;
			}
		});
	
		if (commitMessage) {
			try {
				// First ensure we're on the correct branch BEFORE doing any commits
				await handleBranch(savedBranch);
				
				if (selectionType === 'Commit+Push') {
					const commands = [
						'git add .',
						`git commit -m "${commitMessage}"`,
					];
					
					// Execute add and commit commands
					await executeGitCommand(commands);
					
					// Try pushing and handle possible errors separately
					try {
						await executeGitCommand([`git push -u origin ${savedBranch}`]);
						vscode.window.showInformationMessage(`Successfully committed and pushed to ${savedBranch}`);
					} catch (pushError) {
						// Show specific push error
						vscode.window.showErrorMessage(`Push failed: ${pushError.message}`);
					}
				} else {
					const commands = [
						'git add .',
						`git commit -m "${commitMessage}"`
					];
					
					await executeGitCommand(commands);
					vscode.window.showInformationMessage(`Successfully committed to branch ${savedBranch}`);
				}
				
				outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Commit executed with message: ${commitMessage}`);
			} catch (error) {
				// Show an error notification with details
				const errorMessage = `Git operation failed: ${error.message}`;
				vscode.window.showErrorMessage(errorMessage);
				outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Error: ${error.message}`);
			}
		} else {
			vscode.window.showInformationMessage('Commit cancelled - no message provided.');
		}
	}

	let askCommitCommand = vscode.commands.registerCommand('first.askCommit', async function () {
		// Only show commit dialog if settings are valid
		if (!savedFrequency || !savedBranch) {
			const result = await vscode.window.showErrorMessage(
				'Settings incomplete. Please configure frequency and branch name first.',
				{ modal: true },
				'Open Settings'
			);
			
			if (result === 'Open Settings') {
				vscode.commands.executeCommand('workbench.view.extension.firstSettings');
			}
			return;
		}

		// Directly show options without the redundant "Wanna commit?" prompt
		const selection = await vscode.window.showInformationMessage(
			'Choose commit action:',
			{ modal: false },
			'Commit+Push',
			'Commit',
			'Skip'
		);

		if (selection === 'Commit' || selection === 'Commit+Push') {
			getCommitMessageAndExecute(selection);
		} else {
			vscode.window.showInformationMessage('Commit skipped.');
		}
	});

	// Register start timer command
	let startTimerCommand = vscode.commands.registerCommand('first.startTimer', function () {
		if (!savedFrequency || !savedBranch) {
			vscode.window.showErrorMessage('Settings incomplete. Please configure frequency and branch name first.');
			return;
		}
		
		startTimer();
		vscode.window.showInformationMessage(`Auto-commit timer started with interval of ${savedFrequency} ${TIME_UNIT}.`);
	});

	// Register stop timer command
	let stopTimerCommand = vscode.commands.registerCommand('first.stopTimer', function () {
		stopTimer();
		vscode.window.showInformationMessage('Auto-commit timer stopped.');
	});

	const provider = {
		resolveWebviewView(webviewView) {
			webviewView.webview.options = {
				enableScripts: true
			};

			webviewView.webview.html = getWebviewContent(timerRunning);

			// Listen to messages from the webview
			webviewView.webview.onDidReceiveMessage(message => {
				if (message.command === 'saveSettings') {
					// Validate settings
					if (!message.frequency || !message.branch) {
						webviewView.webview.postMessage({ 
							command: 'validationError',
							hasFrequencyError: !message.frequency,
							hasBranchError: !message.branch
						});
						return;
					}
					
					// Save settings to variables
					savedFrequency = message.frequency;
					savedBranch = message.branch;

					// If timer is running, restart it with new settings
					if (timerRunning) {
						stopTimer();
						startTimer();
					}

					outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Settings Updated`);
					outputChannel.appendLine(`Frequency: ${savedFrequency}`);
					outputChannel.appendLine(`Branch: ${savedBranch}`);
					
					// Notify successful save
					webviewView.webview.postMessage({ command: 'saveSuccess' });
				} else if (message.command === 'startTimer') {
					startTimer();
					webviewView.webview.postMessage({ command: 'timerStarted' });
				} else if (message.command === 'stopTimer') {
					stopTimer();
					webviewView.webview.postMessage({ command: 'timerStopped' });
				}
			});
		}
	};

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("firstSettingsView", provider),
		askCommitCommand,
		startTimerCommand,
		stopTimerCommand,
		commitStatusBarItem,
		timerStatusBarItem,
		outputChannel
	);
}

function getWebviewContent(timerRunning = false) {
	// Define whether we're in production mode (same as in activate function)
	const PRODUCTION_MODE = false;
	const TIME_UNIT = PRODUCTION_MODE ? 'm' : 's';

	return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
                padding: 10px;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-foreground);
            }

            h1 {
                color: var(--vscode-textLink-foreground, #007ACC);
                font-size: 18px;
                margin-bottom: 10px;
            }

            p {
                margin-bottom: 20px;
                font-size: 12px;
                color: var(--vscode-descriptionForeground, #aaa);
            }

            label {
                font-weight: bold;
                display: block;
                margin-bottom: 6px;
                color: var(--vscode-foreground);
                font-size: 14px;
            }

            .field-group {
                margin-bottom: 25px;
                width: 100%;
                max-width: 400px;
                position: relative;
            }

            /* Error message styling */
            .error-message {
                color: #ff5252;
                font-size: 12px;
                margin-top: 5px;
                display: none;
            }

            /* Custom combobox styling */
            .combobox-container {
                position: relative;
                width: 100%;
            }
            
            .combobox-input {
                width: 100%;
                padding: 12px 16px;
                background-color: #1A1B26;
                border: none;
                color: #ccc;
                border-radius: 8px;
                font-size: 14px;
                font-family: 'Segoe UI', sans-serif;
                box-sizing: border-box;
                padding-right: 40px;
                transition: box-shadow 0.2s, background-color 0.2s;
            }

            .combobox-input.error, input[type="text"].error {
                background-color: rgba(255, 82, 82, 0.15);
                box-shadow: 0 0 0 2px rgba(255, 82, 82, 0.5);
            }
            
            .combobox-input:focus {
                outline: none;
                box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.5);
            }
            
            .dropdown-toggle {
                position: absolute;
                right: 12px;
                top: 50%;
                transform: translateY(-50%);
                background: none;
                border: none;
                color: #ccc;
                cursor: pointer;
                padding: 0;
                font-size: 14px;
            }
            
            .dropdown-toggle:after {
                content: '';
                display: inline-block;
                width: 0;
                height: 0;
                border-left: 10px solid transparent;
                border-right: 10px solid transparent;
                border-top: 10px solid #ccc;
            }
            
            .dropdown-menu {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                z-index: 99;
                margin-top: 5px;
                background-color: #1A1B26;
                border-radius: 8px;
                overflow: hidden;
                display: none;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            }
            
            .dropdown-menu.show {
                display: block;
            }
            
            .dropdown-item {
                padding: 12px 16px;
                cursor: pointer;
                font-size: 14px;
                font-family: 'Segoe UI', sans-serif;
                color: #ccc;
                transition: background-color 0.2s;
            }
            
            .dropdown-item:hover {
                background-color: #2A2B36;
            }

            /* Regular input styling */
            input[type="text"] {
                width: 100%;
                padding: 12px 16px;
                background-color: #1A1B26;
                border: none;
                color: #ccc;
                border-radius: 8px;
                font-size: 14px;
                font-family: 'Segoe UI', sans-serif;
                box-sizing: border-box;
                transition: box-shadow 0.2s, background-color 0.2s;
            }

            input:focus {
                outline: none;
                box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.5);
            }

            button {
                background-color: var(--vscode-button-background, #007ACC);
                color: var(--vscode-button-foreground, white);
                border: none;
                padding: 10px 20px;
                border-radius: 25px;
                cursor: pointer;
                font-size: 14px;
                font-family: 'Segoe UI', sans-serif;
                margin-right: 10px;
                margin-bottom: 10px;
            }

            button:hover {
                background-color: var(--vscode-button-hoverBackground, #005f99);
            }
            
            button.green {
                background-color: #4caf50;
            }
            
            button.green:hover {
                background-color: #3d8b40;
            }
            
            button.red {
                background-color: #f44336;
            }
            
            button.red:hover {
                background-color: #d32f2f;
            }
            
            .button-group {
                margin-top: 20px;
                display: flex;
                flex-wrap: wrap;
            }
            
            /* Toast notification styles */
            .toast {
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                background-color: #333;
                color: white;
                padding: 12px 20px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                display: flex;
                align-items: center;
                z-index: 9999;
                opacity: 0;
                transition: opacity 0.3s;
                pointer-events: none;
            }
            
            .toast.show {
                opacity: 1;
            }
            
            .toast.success {
                background-color: #4caf50;
            }
            
            .toast.error {
                background-color: #ff5252;
            }
            
            .toast-icon {
                margin-right: 10px;
                font-weight: bold;
            }
            
            .toast-message {
                font-size: 14px;
            }
            
            .timer-status {
                margin-top: 20px;
                padding: 10px;
                border-radius: 8px;
                background-color: rgba(0, 0, 0, 0.2);
                font-size: 14px;
                display: flex;
                align-items: center;
            }
            
            .timer-status .indicator {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                margin-right: 10px;
            }
            
            .timer-status .indicator.on {
                background-color: #4caf50;
            }
            
            .timer-status .indicator.off {
                background-color: #f44336;
            }
            
            .note {
                margin-top: 20px;
                font-size: 12px;
                color: #999;
                font-style: italic;
            }
        </style>
    </head>
    <body>
        <h1>GLOBAL SETTINGS</h1>
        <p>Configure your auto-commit settings</p>

        <div class="field-group">
            <label for="frequency">How often to commit:</label>
            <div class="combobox-container">
                <input type="text" id="frequency" class="combobox-input" placeholder="e.g. 5" autocomplete="off">
                <button type="button" class="dropdown-toggle" id="dropdownToggle" aria-label="Toggle options"></button>
                <div class="dropdown-menu" id="dropdownMenu">
                    <div class="dropdown-item" data-value="1">Every 1 ${TIME_UNIT}</div>
                    <div class="dropdown-item" data-value="5">Every 5 ${TIME_UNIT}</div>
                    <div class="dropdown-item" data-value="15">Every 15 ${TIME_UNIT}</div>
                    <div class="dropdown-item" data-value="30">Every 30 ${TIME_UNIT}</div>
                </div>
            </div>
            <div class="error-message" id="frequency-error">Please specify how often you want to commit</div>
        </div>

        <div class="field-group">
            <label for="branch">Branch name:</label>
            <input type="text" id="branch" placeholder="main or frontend-developer" />
            <div class="error-message" id="branch-error">Please enter a branch name</div>
        </div>

        <button id="saveBtn">Save Settings</button>

        <div class="timer-status">
            <div class="indicator ${timerRunning ? 'on' : 'off'}" id="timerIndicator"></div>
            <span id="timerStatus">Timer is currently ${timerRunning ? 'running' : 'stopped'}</span>
        </div>

        <div class="button-group">
            <button id="startTimerBtn" class="green">Start Timer</button>
            <button id="stopTimerBtn" class="red">Stop Timer</button>
        </div>
        
        <div class="note">
            * Auto-commit notifications will automatically disappear after 1 minute if not acted upon.
        </div>
        
        <div class="toast" id="toast">
            <span class="toast-icon" id="toast-icon"></span>
            <span class="toast-message" id="toast-message"></span>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            
            // Elements
            const frequencyInput = document.getElementById('frequency');
            const branchInput = document.getElementById('branch');
            const frequencyError = document.getElementById('frequency-error');
            const branchError = document.getElementById('branch-error');
            const dropdownToggle = document.getElementById('dropdownToggle');
            const dropdownMenu = document.getElementById('dropdownMenu');
            const dropdownItems = document.querySelectorAll('.dropdown-item');
            const saveBtn = document.getElementById('saveBtn');
            const toast = document.getElementById('toast');
            const toastIcon = document.getElementById('toast-icon');
            const toastMessage = document.getElementById('toast-message');
            const startTimerBtn = document.getElementById('startTimerBtn');
            const stopTimerBtn = document.getElementById('stopTimerBtn');
            const timerIndicator = document.getElementById('timerIndicator');
            const timerStatus = document.getElementById('timerStatus');
            
            // Timer state
            let isTimerRunning = ${timerRunning};
            updateTimerUI();
            
            // Validation function
            function validateInputs() {
                let isValid = true;
                
                // Validate frequency
                if (!frequencyInput.value.trim()) {
                    frequencyInput.classList.add('error');
                    frequencyError.style.display = 'block';
                    isValid = false;
                } else {
                    frequencyInput.classList.remove('error');
                    frequencyError.style.display = 'none';
                }
                
                // Validate branch
                if (!branchInput.value.trim()) {
                    branchInput.classList.add('error');
                    branchError.style.display = 'block';
                    isValid = false;
                } else {
                    branchInput.classList.remove('error');
                    branchError.style.display = 'none';
                }
                
                return isValid;
            }
            
            // Update timer UI based on state
            function updateTimerUI() {
                if (isTimerRunning) {
                    timerIndicator.classList.remove('off');
                    timerIndicator.classList.add('on');
                    timerStatus.textContent = 'Timer is currently running';
                } else {
                    timerIndicator.classList.remove('on');
                    timerIndicator.classList.add('off');
                    timerStatus.textContent = 'Timer is currently stopped';
                }
            }
            
            // Show toast notification
            function showToast(message, type = 'error') {
                toast.className = 'toast show ' + type;
                toastIcon.textContent = type === 'success' ? '✓' : '✗';
                toastMessage.textContent = message;
                
                setTimeout(() => {
                    toast.classList.remove('show');
                }, 3000);
            }

            // Handle input changes to clear errors
            frequencyInput.addEventListener('input', function() {
                if (this.value.trim()) {
                    this.classList.remove('error');
                    frequencyError.style.display = 'none';
                }
            });
            
            branchInput.addEventListener('input', function() {
                if (this.value.trim()) {
                    this.classList.remove('error');
                    branchError.style.display = 'none';
                }
            });

            // Combobox functionality
            dropdownToggle.addEventListener('click', function(e) {
                e.stopPropagation();
                dropdownMenu.classList.toggle('show');
            });

            // Handle dropdown item selection
            dropdownItems.forEach(item => {
                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const value = this.getAttribute('data-value');
                    frequencyInput.value = value;
                    frequencyInput.classList.remove('error');
                    frequencyError.style.display = 'none';
                    dropdownMenu.classList.remove('show');
                });
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', function() {
                dropdownMenu.classList.remove('show');
            });

            // Save button functionality
            saveBtn.addEventListener('click', () => {
                if (!validateInputs()) {
                    showToast('Please fill in all required fields', 'error');
                    return;
                }
                
                const frequency = frequencyInput.value.trim();
                const branch = branchInput.value.trim();

                vscode.postMessage({
                    command: 'saveSettings',
                    frequency,
                    branch
                });
            });
            
            // Start timer button
            startTimerBtn.addEventListener('click', () => {
                if (!validateInputs()) {
                    showToast('Please fill in all required fields and save settings first', 'error');
                    return;
                }
                
                vscode.postMessage({
                    command: 'startTimer'
                });
            });
            
            // Stop timer button
            stopTimerBtn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'stopTimer'
                });
            });
            
            // Listen for messages from extension
            window.addEventListener('message', event => {
                const message = event.data;
                
                if (message.command === 'validationError') {
                    if (message.hasFrequencyError) {
                        frequencyInput.classList.add('error');
                        frequencyError.style.display = 'block';
                    }
                    
                    if (message.hasBranchError) {
                        branchInput.classList.add('error');
                        branchError.style.display = 'block';
                    }
                    
                    showToast('Please fill in all required fields', 'error');
                } else if (message.command === 'saveSuccess') {
                    showToast('Settings saved successfully!', 'success');
                } else if (message.command === 'timerStarted') {
                    isTimerRunning = true;
                    updateTimerUI();
                    showToast('Timer started successfully!', 'success');
                } else if (message.command === 'timerStopped') {
                    isTimerRunning = false;
                    updateTimerUI();
                    showToast('Timer stopped', 'success');
                }
            });
        </script>
    </body>
    </html>
    `;
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
};
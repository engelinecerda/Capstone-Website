// ========================
// State
// ========================
let currentStep = 1;
let selectedLocationType = '';   // 'onsite' or 'offsite'
let selectedCategory = '';       // 'mini', 'snack', 'coffee', 'catering', 'foodtray'
let selectedCategoryLabel = '';
let selectedPackage = '';        // specific package value
let selectedPackageLabel = '';
let selectedPackagePrice = 0;
let selectedTime = '';
let selectedDish = '';
let selectedPax = 0;
let isFoodTray = false;

// Simulated login state — change to true to test logged-in flow
const isLoggedIn = false;

// ========================
// Package Data
// ========================

// Step 2: Categories per location type
const onsiteCategories = [
    { label: "Mini Gathering", value: "mini", desc: "Private venue packages at ELI Coffee", icon: "🏠" },
    { label: "Snack Bar Corner", value: "snack", desc: "Mobile snack bar with chocolate fountain", icon: "🍪" }
];

const offsiteCategories = [
    { label: "Eli Coffee Bar", value: "coffee", desc: "Professional coffee bar service for events", icon: "☕" },
    { label: "Snack Bar Corner", value: "snack", desc: "Mobile snack bar with chocolate fountain", icon: "🍪" },
    { label: "Catering", value: "catering", desc: "Fully customizable catering for any event", icon: "🍽️" },
    { label: "Food Tray", value: "foodtray", desc: "Ready to serve meal trays for any gathering", icon: "🍱" }
];

// Step 3: Specific packages per category
const specificPackages = {
    mini: [
        { label: "VIP Lite", price: 2999, desc: "2 hours • 15–18 pax • ₱2,000 food credit" },
        { label: "VIP Plus", price: 3999, desc: "3 hours • 15–18 pax • ₱2,499 food credit" },
        { label: "VIP Max", price: 4999, desc: "4 hours • 15–18 pax • ₱3,000 food credit" },
        { label: "Main Hall Basic", price: 9999, desc: "2 hours • up to 25 pax • ₱8,000 food credit" },
        { label: "Main Hall Plus", price: 11999, desc: "3 hours • up to 25 pax • ₱9,000 food credit" }
    ],
    snack: [
        { label: "Biscuits & Candies", price: 3500, desc: "Chocolate fountain, biscuits, candies, marshmallow, brownies, 20 donuts" },
        { label: "Biscuits, Candies & Fruits", price: 4000, desc: "Chocolate fountain, biscuits, candies, marshmallow, 4 seasonal fruits" },
        { label: "Biscuits, Chips & Drinks", price: 5000, desc: "Chocolate fountain, biscuits, chips, cupcakes, marshmallow, 2 drinks" }
    ],
    coffee: [
        { label: "30 pax", price: 3990, desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" },
        { label: "50 pax", price: 5990, desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" },
        { label: "100 pax", price: 10990, desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" },
        { label: "150 pax", price: 14990, desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" }
    ],
    catering: [
        { label: "Custom Catering Package", price: 0, desc: "Buffet setup, table & chair setup, uniformed waiters • Price varies by guest count" }
    ],
    foodtray: [] // handled separately in step 4
};

// Step 4: Food tray data
const foodTrayData = [
    { category: "🍗 Chicken", key: "Chicken", items: ["Chicken ala King", "Chicken Fillet w/ White Sauce", "Garlic Butter Chicken"] },
    { category: "🥩 Pork", key: "Pork", items: ["Pork with Mushroom", "Crunchy Pork", "Pork Caldereta"] },
    { category: "🥦 Beef", key: "Beef", items: ["Beef Teriyaki", "Beef Salpicao", "Beef and Broccoli"] },
    { category: "🐟 Fish", key: "Fish", items: ["Fish Fillet with Tartar Sauce", "Sweet and Sour Fish Fillet"] },
    { category: "🥕 Vegetables", key: "Vegetables", items: ["Mixed Vegetables in Butter Corn and Carrots", "Potato Marble"] },
    { category: "🍝 Pasta", key: "Pasta", items: ["Spaghetti", "Carbonara", "Baked Macaroni", "Tuna Pesto", "Pancit Canton"] },
    { category: "🍮 Dessert", key: "Dessert", items: ["Coffee Jelly", "Buko Pandan", "Mango Sago", "Chocolate Mousse"] }
];

const priceTable = {
    Chicken:    { 20: 2700, 30: 3800, 40: 4800, 50: 5900 },
    Pork:       { 20: 2700, 30: 3800, 40: 4800, 50: 5900 },
    Beef:       { 20: 2700, 30: 3800, 40: 4800, 50: 5900 },
    Fish:       { 20: 2400, 30: 3400, 40: 4500, 50: 5600 },
    Vegetables: { 20: 2400, 30: 3400, 40: 4500, 50: 5600 },
    Pasta:      { 20: 2000, 30: 2900, 40: 3800, 50: 4600 },
    Dessert:    { 20: 1400, 30: 2900, 40: 2600, 50: 3200 },
    Rice:       { 20: 600,  30: 900,  40: 1200, 50: 1500 }
};

const times = [
    
    "1:00 PM", "2:00 PM",  "3:00 PM",  "4:00 PM",
    "5:00 PM", "6:00 PM",  "7:00 PM",  "8:00 PM",
    "9:00 PM", "10:00 PM"

];

// ========================
// Step Map
// Without food tray: 10 steps (1-10, skipping step4)
// With food tray:    10 steps (1-10, including step4)
// HTML steps: step1, step2, step3, step4(foodtray), step5, step6, step7, step8, step9, step10
// ========================
function getTotalSteps() {
    return isFoodTray ? 10 : 9;
}

function getStepId(n) {
    if (!isFoodTray) {
        // Skip step4 (food tray) when not food tray
        const map = {
            1: 'step1',   // Location type
            2: 'step2',   // Category
            3: 'step3',   // Specific package
            4: 'step5',   // Event date
            5: 'step6',   // Time slot
            6: 'step7',   // Details
            7: 'step8',   // Order summary
            8: 'step9',   // Reservation summary
            9: 'step10'   // Contract
        };
        return map[n] || 'step1';
    } else {
        const map = {
            1:  'step1',   // Location type
            2:  'step2',   // Category
            3:  'step3',   // Specific package (foodtray category)
            4:  'step4',   // Food tray dish/pax selection
            5:  'step5',   // Event date
            6:  'step6',   // Time slot
            7:  'step7',   // Details
            8:  'step8',   // Order summary
            9:  'step9',   // Reservation summary
            10: 'step10'   // Contract
        };
        return map[n] || 'step1';
    }
}

// ========================
// DOM References
// ========================
const allSteps = document.querySelectorAll('.step');
const progress = document.getElementById('progress');
const stepText = document.getElementById('step-text');
const nextBtn = document.getElementById('nextBtn');
const prevBtn = document.getElementById('prevBtn');

// ========================
// Validation
// ========================
function validateStep(n) {
    const stepId = getStepId(n);

    switch (stepId) {
        case 'step1':
            if (!selectedLocationType) {
                alert('Please select Onsite or Offsite.');
                return false;
            }
            return true;

        case 'step2':
            if (!selectedCategory) {
                alert('Please select a package category.');
                return false;
            }
            return true;

        case 'step3':
            if (isFoodTray) {
                // For food tray, step3 just confirms category selection
                return true;
            }
            if (!selectedPackage) {
                alert('Please select a specific package.');
                return false;
            }
            return true;

        case 'step4':
            // Food tray dish + pax validation
            if (!selectedPackage.includes('pax')) {
                alert('Please select a dish and number of pax for your food tray.');
                return false;
            }
            return true;

        case 'step5':
            const dateVal = document.getElementById('event-date').value;
            if (!dateVal) {
                alert('Please select an event date.');
                return false;
            }
            const chosenDate = new Date(dateVal);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (chosenDate < today) {
                alert('Please select a future date.');
                return false;
            }
            return true;

        case 'step6':
            if (!selectedTime) {
                alert('Please select a time slot.');
                return false;
            }
            return true;

        case 'step7':
            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim();
            const phone = document.getElementById('phone').value.trim();
            const eventType = document.getElementById('event-type').value.trim();
            const guestCount = document.getElementById('guest-count').value.trim();
            const venueLocation = document.getElementById('venue-location');

            if (!name || !email || !phone || !eventType || !guestCount) {
                alert('Please fill in all required fields.');
                return false;
            }
            if (!/^\S+@\S+\.\S+$/.test(email)) {
                alert('Please enter a valid email address.');
                return false;
            }
            if (selectedLocationType === 'offsite' && venueLocation && !venueLocation.value.trim()) {
                alert('Please enter the venue location for your offsite event.');
                return false;
            }
            return true;

        case 'step8':
            // Order summary — no validation needed
            return true;

        case 'step9':
            // If not logged in, block and show warning
            if (!isLoggedIn) {
                const warning = document.getElementById('guest-warning');
                if (warning) warning.style.display = 'flex';
                return false;
            }
            return true;

        case 'step10':
            if (!document.getElementById('contract').files.length) {
                alert('Please upload your signed contract before submitting.');
                return false;
            }
            return true;

        default:
            return true;
    }
}

// ========================
// Show Step
// ========================
function showStep(n) {
    allSteps.forEach(s => s.classList.remove('active'));

    const stepId = getStepId(n);
    const target = document.getElementById(stepId);
    if (target) target.classList.add('active');

    prevBtn.style.display = n === 1 ? 'none' : 'inline-block';
    nextBtn.innerText = n === getTotalSteps() ? 'Submit' : 'Next';

    progress.style.width = ((n / getTotalSteps()) * 100) + '%';
    stepText.innerText = `Step ${n} of ${getTotalSteps()}: ${target ? target.querySelector('h2').innerText : ''}`;

    populateStep(stepId);
}

// ========================
// Populate Steps
// ========================
function populateStep(stepId) {

    // Step 2: Category options
    if (stepId === 'step2') {
        const container = document.getElementById('category-options');
        container.innerHTML = '';
        const categories = selectedLocationType === 'onsite' ? onsiteCategories : offsiteCategories;

        categories.forEach(cat => {
            const card = document.createElement('div');
            card.className = 'package-card';

            card.innerHTML = `
                <h4>${cat.icon} ${cat.label}</h4>
                <p class="card-desc">${cat.desc}</p>
            `;

            card.addEventListener('click', () => {
                container.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedCategory = cat.value;
                selectedCategoryLabel = cat.label;
                isFoodTray = cat.value === 'foodtray';
                selectedPackage = '';
                selectedPackageLabel = '';
                selectedPackagePrice = 0;
            });

            container.appendChild(card);
        });
    }

    // Step 3: Specific packages
    if (stepId === 'step3') {
        const container = document.getElementById('specific-package-options');
        container.innerHTML = '';

        if (isFoodTray) {
            // For food tray, just confirm and move to step 4
            const info = document.createElement('div');
            info.className = 'summary-box';
            info.innerHTML = `
                <p><span>Selected:</span> 🍱 Food Tray</p>
                <p style="color:#888; font-size:13px;">On the next step, you'll select your dish and number of pax.</p>
            `;
            container.appendChild(info);
            return;
        }

        const packages = specificPackages[selectedCategory] || [];

        packages.forEach(pkg => {
            const card = document.createElement('div');
            card.className = 'package-card';

            card.innerHTML = `
                <h4>${pkg.label}</h4>
                <p class="card-price">₱${pkg.price > 0 ? pkg.price.toLocaleString() : 'Contact for quote'}</p>
                <p class="card-desc">${pkg.desc}</p>
            `;

            card.addEventListener('click', () => {
                container.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedPackage = pkg.label;
                selectedPackageLabel = pkg.label;
                selectedPackagePrice = pkg.price;
            });

            container.appendChild(card);
        });
    }

    // Step 4: Food tray dish + pax
    if (stepId === 'step4') {
        const container = document.getElementById('foodtray-options');
        if (!container) return;
        container.innerHTML = '';

        foodTrayData.forEach(group => {
            const card = document.createElement('div');
            card.className = 'package-card foodtray';

            const title = document.createElement('h4');
            title.innerText = group.category;
            card.appendChild(title);

            const dishSection = document.createElement('div');
            dishSection.className = 'dish-section';

            group.items.forEach(item => {
                const pill = document.createElement('div');
                pill.className = 'option-pill';
                pill.innerText = item;
                pill.addEventListener('click', () => {
                    dishSection.querySelectorAll('.option-pill').forEach(p => p.classList.remove('selected'));
                    pill.classList.add('selected');
                    selectedDish = item;
                    updateFoodTraySelection(group.key, card);
                });
                dishSection.appendChild(pill);
            });
            card.appendChild(dishSection);

            const paxSection = document.createElement('div');
            paxSection.className = 'pax-section';

            const paxLabel = document.createElement('div');
            paxLabel.className = 'pax-label';
            paxLabel.innerText = 'Select number of pax:';
            paxSection.appendChild(paxLabel);

            const paxGroup = document.createElement('div');
            paxGroup.className = 'pax-group';

            [20, 30, 40, 50].forEach(pax => {
                const pill = document.createElement('div');
                pill.className = 'option-pill';
                pill.innerText = `${pax} pax`;
                pill.addEventListener('click', () => {
                    paxGroup.querySelectorAll('.option-pill').forEach(p => p.classList.remove('selected'));
                    pill.classList.add('selected');
                    selectedPax = pax;
                    updateFoodTraySelection(group.key, card);
                });
                paxGroup.appendChild(pill);
            });

            paxSection.appendChild(paxGroup);
            card.appendChild(paxSection);

            const priceDisplay = document.createElement('div');
            priceDisplay.className = 'price-display';
            card.appendChild(priceDisplay);

            container.appendChild(card);
        });
    }

    // Step 6: Time slots
    if (stepId === 'step6') {
        const container = document.getElementById('time-options');
        container.innerHTML = '';
        times.forEach(time => {
            const card = document.createElement('div');
            card.className = 'package-card';
            card.innerText = time;
            card.style.textAlign = 'center';
            card.addEventListener('click', () => {
                container.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedTime = time;
            });
            container.appendChild(card);
        });
    }

    // Step 7: Show/hide venue location for offsite
    if (stepId === 'step7') {
        const venueWrapper = document.getElementById('venue-location-wrapper');
        if (venueWrapper) {
            venueWrapper.style.display = selectedLocationType === 'offsite' ? 'block' : 'none';
        }
    }

    // Step 8: Order Summary
    if (stepId === 'step8') {
        const box = document.getElementById('order-summary-content');
        if (!box) return;

        const totalPrice = selectedPackagePrice > 0
            ? `₱${selectedPackagePrice.toLocaleString()}`
            : 'Contact for quote';

        box.innerHTML = `
            <p><span>Location Type:</span> ${selectedLocationType === 'onsite' ? '🏠 Onsite' : '🚗 Offsite'}</p>
            <p><span>Category:</span> ${selectedCategoryLabel}</p>
            <p><span>Package:</span> ${selectedPackageLabel || selectedPackage}</p>
            ${isFoodTray ? `<p><span>Food Tray:</span> ${selectedPackage}</p>` : ''}
            <hr class="summary-divider">
            <p class="summary-total">Total: ${totalPrice}</p>
        `;
    }

    // Step 9: Full Reservation Summary
    if (stepId === 'step9') {
        const box = document.getElementById('reservation-summary-content');
        if (!box) return;

        const date = document.getElementById('event-date').value;
        const name = document.getElementById('name').value;
        const email = document.getElementById('email').value;
        const phone = document.getElementById('phone').value;
        const eventType = document.getElementById('event-type').value;
        const guestCount = document.getElementById('guest-count').value;
        const venueLocation = document.getElementById('venue-location');
        const requests = document.getElementById('requests').value;

        const totalPrice = selectedPackagePrice > 0
            ? `₱${selectedPackagePrice.toLocaleString()}`
            : 'Contact for quote';

        box.innerHTML = `
            <p><span>Type:</span> ${selectedLocationType === 'onsite' ? '🏠 Onsite' : '🚗 Offsite'}</p>
            <p><span>Category:</span> ${selectedCategoryLabel}</p>
            <p><span>Package:</span> ${selectedPackageLabel || selectedPackage}</p>
            ${isFoodTray ? `<p><span>Food Tray Selection:</span> ${selectedPackage}</p>` : ''}
            <p><span>Date:</span> ${date}</p>
            <p><span>Time:</span> ${selectedTime}</p>
            <hr class="summary-divider">
            <p><span>Name:</span> ${name}</p>
            <p><span>Email:</span> ${email}</p>
            <p><span>Phone:</span> ${phone}</p>
            <p><span>Event Type:</span> ${eventType}</p>
            <p><span>Number of Guests:</span> ${guestCount}</p>
            ${selectedLocationType === 'offsite' && venueLocation && venueLocation.value ? `<p><span>Venue Location:</span> ${venueLocation.value}</p>` : ''}
            ${requests ? `<p><span>Special Requests:</span> ${requests}</p>` : ''}
            <hr class="summary-divider">
            <p class="summary-total">Total: ${totalPrice}</p>
        `;

        // Show guest warning if not logged in
        const warning = document.getElementById('guest-warning');
        if (warning) warning.style.display = !isLoggedIn ? 'flex' : 'none';
    }
}

// ========================
// Food Tray Price Updater
// ========================
function updateFoodTraySelection(categoryKey, card) {
    const priceDisplay = card.querySelector('.price-display');
    const selectedDishPill = card.querySelector('.dish-section .option-pill.selected');
    const selectedPaxPill = card.querySelector('.pax-group .option-pill.selected');

    if (selectedDishPill && selectedPaxPill) {
        const pax = parseInt(selectedPaxPill.innerText);
        const price = priceTable[categoryKey] ? priceTable[categoryKey][pax] : null;
        if (price) {
            priceDisplay.innerText = `₱${price.toLocaleString()}`;
            selectedPackage = `${categoryKey} - ${selectedDishPill.innerText} - ${pax} pax`;
            selectedPackageLabel = selectedPackage;
            selectedPackagePrice = price;
        }
    }
}

// ========================
// Next Button
// ========================
nextBtn.addEventListener('click', () => {
    if (!validateStep(currentStep)) return;

    if (currentStep < getTotalSteps()) {
        currentStep++;
        showStep(currentStep);
    } else {
        // Final submit
        allSteps.forEach(s => s.classList.remove('active'));
        document.querySelector('.reservation-buttons').style.display = 'none';
        document.querySelector('.progress-container').style.display = 'none';

        const successMsg = document.createElement('div');
        successMsg.className = 'summary-box';
        successMsg.style.textAlign = 'center';
        successMsg.style.padding = '40px';
        successMsg.innerHTML = `
            <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
            <h3 style="color: #2A1408; font-size: 20px; margin-bottom: 12px;">Reservation Submitted!</h3>
            <p style="color: #666; line-height: 1.8;">
                Thank you, <strong>${document.getElementById('name').value}</strong>!<br>
                Your reservation is now <strong style="color: #6B3A1F;">under verification</strong>.<br>
                We will contact you shortly to confirm your booking.
            </p>
        `;
        document.querySelector('.reservation-container').appendChild(successMsg);
    }
});

// ========================
// Previous Button
// ========================
prevBtn.addEventListener('click', () => {
    if (currentStep > 1) {
        currentStep--;
        showStep(currentStep);
    }
});

// ========================
// Step 1: Location Selection
// ========================
document.querySelectorAll('#step1 .location-select-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('#step1 .location-select-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedLocationType = card.dataset.value;
        // Reset downstream state
        selectedCategory = '';
        selectedCategoryLabel = '';
        selectedPackage = '';
        selectedPackageLabel = '';
        selectedPackagePrice = 0;
        isFoodTray = false;
    });
});

// ========================
// Initialize
// ========================
showStep(currentStep);
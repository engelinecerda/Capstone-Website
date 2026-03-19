// ========================
// State
// ========================
let currentStep = 1;

// Simulated login state — change to true to test logged-in flow
const isLoggedIn = false;

let state = {
    eventType:       '',
    guestCount:      '',
    eventDate:       '',
    locationType:    '',   // 'onsite' | 'offsite'
    venueLocation:   '',
    miniPackage:     null, // { label, price, pax, hours, credit }
    snackAddon:      null, // { label, price, desc } | null
    offsiteCategory: '',   // 'coffee' | 'snack' | 'catering' | 'foodtray'
    offsitePackage:  null, // { label, price, desc }
    trayCart:        [],   // [{ category, dish, pax, price }]
    name:            '',
    phone:           '',
    email:           '',
    requests:        '',
    time:            ''
};

// ========================
// Package Data
// ========================
const miniPackages = [
    { label: "VIP Lite",        price: 2999,  pax: "15–18 pax", hours: "2 hours", credit: "₱2,000 food credit" },
    { label: "VIP Plus",        price: 3999,  pax: "15–18 pax", hours: "3 hours", credit: "₱2,499 food credit" },
    { label: "VIP Max",         price: 4999,  pax: "15–18 pax", hours: "4 hours", credit: "₱3,000 food credit" },
    { label: "Main Hall Basic", price: 9999,  pax: "Up to 25 pax", hours: "2 hours", credit: "₱8,000 food credit" },
    { label: "Main Hall Plus",  price: 11999, pax: "Up to 25 pax", hours: "3 hours", credit: "₱9,000 food credit" }
];

const snackPackages = [
    { label: "Biscuits & Candies",         price: 3500, desc: "Chocolate fountain, biscuits, candies, marshmallow, brownies, 20 donuts" },
    { label: "Biscuits, Candies & Fruits", price: 4000, desc: "Chocolate fountain, biscuits, candies, marshmallow, 4 seasonal fruits" },
    { label: "Biscuits, Chips & Drinks",   price: 5000, desc: "Chocolate fountain, biscuits, chips, cupcakes, marshmallow, 2 drinks" }
];

const offsiteCategories = [
    { label: "Eli Coffee Bar",   value: "coffee",   icon: "☕", desc: "Professional coffee bar service for your event" },
    { label: "Snack Bar Corner", value: "snack",    icon: "🍪", desc: "Mobile snack bar with chocolate fountain" },
    { label: "Catering",         value: "catering", icon: "🍽️", desc: "Fully customizable catering for any event" },
    { label: "Food Tray",        value: "foodtray", icon: "🍱", desc: "Ready to serve meal trays for any gathering" }
];

const offsiteSubPackages = {
    coffee: [
        { label: "30 pax",  price: 3990,  desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" },
        { label: "50 pax",  price: 5990,  desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" },
        { label: "100 pax", price: 10990, desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" },
        { label: "150 pax", price: 14990, desc: "2–3 baristas • 3 hours service • 1:1 coffee serving" }
    ],
    snack: snackPackages,
    catering: [
        { label: "Custom Catering Package", price: 0, desc: "Buffet setup, table & chair setup, uniformed waiters • Price varies by guest count" }
    ]
};

const foodTrayData = [
    { category: "Chicken",    icon: "🍗", items: ["Chicken ala King", "Chicken Fillet w/ White Sauce", "Garlic Butter Chicken"] },
    { category: "Pork",       icon: "🥩", items: ["Pork with Mushroom", "Crunchy Pork", "Pork Caldereta"] },
    { category: "Beef",       icon: "🥩", items: ["Beef Teriyaki", "Beef Salpicao", "Beef and Broccoli"] },
    { category: "Fish",       icon: "🐟", items: ["Fish Fillet with Tartar Sauce", "Sweet and Sour Fish Fillet"] },
    { category: "Vegetables", icon: "🥦", items: ["Mixed Vegetables in Butter Corn and Carrots", "Potato Marble"] },
    { category: "Pasta",      icon: "🍝", items: ["Spaghetti", "Carbonara", "Baked Macaroni", "Tuna Pesto", "Pancit Canton"] },
    { category: "Dessert",    icon: "🍮", items: ["Coffee Jelly", "Buko Pandan", "Mango Sago", "Chocolate Mousse"] }
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
    "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM",
    "5:00 PM", "6:00 PM", "7:00 PM", "8:00 PM",
    "9:00 PM", "10:00 PM"
];

// ========================
// Step Map
// Food Tray adds step4; all other flows skip it
// ========================
function isFoodTray() {
    return state.locationType === 'offsite' && state.offsiteCategory === 'foodtray';
}

function getStepIds() {
    return isFoodTray()
        ? ['step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7', 'step8']
        : ['step1', 'step2', 'step3',           'step5', 'step6', 'step7', 'step8'];
}

function getTotalSteps() { return getStepIds().length; }
function getStepId(n)    { return getStepIds()[n - 1]; }

// ========================
// DOM References
// ========================
const progressBar = document.getElementById('progress');
const stepText    = document.getElementById('step-text');
const nextBtn     = document.getElementById('nextBtn');
const prevBtn     = document.getElementById('prevBtn');

// ========================
// Show Step
// ========================
function showStep(n) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));

    const stepId = getStepId(n);
    const el = document.getElementById(stepId);
    if (el) el.classList.add('active');

    progressBar.style.width = ((n / getTotalSteps()) * 100) + '%';
    stepText.innerText = `Step ${n} of ${getTotalSteps()}: ${el ? el.querySelector('h2').innerText : ''}`;

    prevBtn.style.display = n === 1 ? 'none' : 'inline-block';
    nextBtn.innerText = n === getTotalSteps() ? 'Submit' : 'Next';

    populateStep(stepId);
}

// ========================
// Populate Steps
// ========================
function populateStep(stepId) {
    if (stepId === 'step3') populateStep3();
    if (stepId === 'step4') populateStep4();
    if (stepId === 'step6') populateTimeSlots();
    if (stepId === 'step7') populateSummary();
    if (id === 'rs8') buildContractStep();
}

function buildContractStep() {
    const url = getContractUrl();
    const btn = document.querySelector('.dl-btn');
    if (btn && url) {
        btn.href = url;
    }
}

// --- Step 3 ---
function populateStep3() {
    const onsiteSection  = document.getElementById('onsite-mini-section');
    const offsiteSection = document.getElementById('offsite-categories');
    const desc           = document.getElementById('step3-desc');

    if (state.locationType === 'onsite') {
        show(onsiteSection);
        hide(offsiteSection);
        desc.innerText = 'Select a gathering package for your event';
        buildMiniPackages();
    } else {
        hide(onsiteSection);
        show(offsiteSection);
        desc.innerText = 'Choose the type of service you need';
        buildOffsiteCategories();
    }
}

function buildMiniPackages() {
    const container = document.getElementById('mini-options');
    container.innerHTML = '';

    miniPackages.forEach(pkg => {
        const card = makeCard(
            `<h4>${pkg.label}</h4>
             <p class="card-price">₱${pkg.price.toLocaleString()}</p>
             <p class="card-desc">${pkg.pax} • ${pkg.hours} • ${pkg.credit}</p>`,
            state.miniPackage && state.miniPackage.label === pkg.label
        );
        card.addEventListener('click', () => {
            state.miniPackage = pkg;
            selectCard(container, card);
            show(document.getElementById('snack-addon-banner'));
            buildSnackOptions();
        });
        container.appendChild(card);
    });
}

function buildSnackOptions() {
    const container = document.getElementById('snack-options-onsite');
    container.innerHTML = '';

    // "No add-on" option
    const noneCard = makeCard(
        `<h4>No Add-on</h4><p class="card-desc">Skip the snack bar corner</p>`,
        state.snackAddon === null
    );
    noneCard.addEventListener('click', () => {
        state.snackAddon = null;
        selectCard(container, noneCard);
    });
    container.appendChild(noneCard);

    snackPackages.forEach(pkg => {
        const card = makeCard(
            `<h4>${pkg.label}</h4>
             <p class="card-price">₱${pkg.price.toLocaleString()}</p>
             <p class="card-desc">${pkg.desc}</p>`,
            state.snackAddon && state.snackAddon.label === pkg.label
        );
        card.addEventListener('click', () => {
            state.snackAddon = pkg;
            selectCard(container, card);
        });
        container.appendChild(card);
    });
}

function buildOffsiteCategories() {
    const container = document.getElementById('offsite-cat-options');
    container.innerHTML = '';

    offsiteCategories.forEach(cat => {
        const card = makeCard(
            `<h4>${cat.icon} ${cat.label}</h4><p class="card-desc">${cat.desc}</p>`,
            state.offsiteCategory === cat.value
        );
        card.addEventListener('click', () => {
            state.offsiteCategory = cat.value;
            state.offsitePackage  = null;
            state.trayCart        = [];
            selectCard(container, card);

            const subSection = document.getElementById('offsite-sub-section');
            if (cat.value === 'foodtray') {
                hide(subSection);
            } else {
                show(subSection);
                document.getElementById('offsite-sub-label').innerText = `Choose a ${cat.label} Package`;
                buildOffsiteSubPackages(cat.value);
            }
        });
        container.appendChild(card);
    });
}

function buildOffsiteSubPackages(catValue) {
    const container = document.getElementById('offsite-sub-options');
    container.innerHTML = '';

    (offsiteSubPackages[catValue] || []).forEach(pkg => {
        const card = makeCard(
            `<h4>${pkg.label}</h4>
             <p class="card-price">${pkg.price > 0 ? '₱' + pkg.price.toLocaleString() : 'Contact for quote'}</p>
             <p class="card-desc">${pkg.desc}</p>`,
            state.offsitePackage && state.offsitePackage.label === pkg.label
        );
        card.addEventListener('click', () => {
            state.offsitePackage = pkg;
            selectCard(container, card);
        });
        container.appendChild(card);
    });
}

// --- Step 4: Food Tray Builder ---
function populateStep4() {
    const builder = document.getElementById('foodtray-builder');
    builder.innerHTML = '';

    foodTrayData.forEach(group => {
        const section = document.createElement('div');
        section.className = 'tray-section';
        section.innerHTML = `<div class="tray-header"><span class="tray-icon">${group.icon}</span><h4>${group.category}</h4></div>`;

        // Dish pills
        const dishGrid = document.createElement('div');
        dishGrid.className = 'dish-grid';
        group.items.forEach(item => {
            const pill = makePill(item);
            pill.addEventListener('click', () => {
                selectPill(dishGrid, pill);
                section.dataset.dish = item;
                tryAddToCart(group, section);
            });
            dishGrid.appendChild(pill);
        });
        section.appendChild(dishGrid);

        // Pax pills
        const paxRow = document.createElement('div');
        paxRow.className = 'pax-row';
        paxRow.innerHTML = '<span class="pax-label">Number of Pax:</span>';
        [20, 30, 40, 50].forEach(pax => {
            const pill = makePill(`${pax} pax`);
            pill.addEventListener('click', () => {
                selectPill(paxRow, pill);
                section.dataset.pax = pax;
                tryAddToCart(group, section);
            });
            paxRow.appendChild(pill);
        });
        section.appendChild(paxRow);

        const hr = document.createElement('hr');
        hr.className = 'tray-divider';
        section.appendChild(hr);

        builder.appendChild(section);
    });

    // Rice add-on
    const riceSection = document.createElement('div');
    riceSection.className = 'tray-section';
    riceSection.innerHTML = `<div class="tray-header"><span class="tray-icon">🍚</span><h4>Rice <span class="section-label-optional">(Add-on)</span></h4></div>`;
    const ricePaxRow = document.createElement('div');
    ricePaxRow.className = 'pax-row';
    ricePaxRow.innerHTML = '<span class="pax-label">Number of Pax:</span>';
    [20, 30, 40, 50].forEach(pax => {
        const pill = makePill(`${pax} pax`);
        pill.addEventListener('click', () => {
            selectPill(ricePaxRow, pill);
            state.trayCart = state.trayCart.filter(i => i.category !== 'Rice');
            state.trayCart.push({ category: 'Rice', dish: 'Steamed Rice', pax, price: priceTable['Rice'][pax] });
            renderTrayCart();
        });
        ricePaxRow.appendChild(pill);
    });
    riceSection.appendChild(ricePaxRow);
    builder.appendChild(riceSection);

    renderTrayCart();
}

function tryAddToCart(group, section) {
    const dish = section.dataset.dish;
    const pax  = parseInt(section.dataset.pax);
    if (!dish || !pax) return;
    const price = priceTable[group.category] && priceTable[group.category][pax];
    if (!price) return;
    state.trayCart = state.trayCart.filter(i => i.category !== group.category);
    state.trayCart.push({ category: group.category, dish, pax, price });
    renderTrayCart();
}

function renderTrayCart() {
    const cart  = document.getElementById('tray-cart');
    const items = document.getElementById('tray-cart-items');
    const total = document.getElementById('tray-cart-total');

    if (!state.trayCart.length) { hide(cart); return; }
    show(cart);
    items.innerHTML = '';
    let sum = 0;
    state.trayCart.forEach(item => {
        sum += item.price;
        const row = document.createElement('div');
        row.className = 'tray-cart-row';
        row.innerHTML = `<span>${item.category} — ${item.dish} (${item.pax} pax)</span><span>₱${item.price.toLocaleString()}</span>`;
        items.appendChild(row);
    });
    total.innerText = `Total: ₱${sum.toLocaleString()}`;
}

// --- Step 6: Time Slots ---
function populateTimeSlots() {
    const container = document.getElementById('time-options');
    container.innerHTML = '';
    times.forEach(t => {
        const card = makeCard(`<span>${t}</span>`, state.time === t);
        card.style.textAlign = 'center';
        card.addEventListener('click', () => {
            state.time = t;
            selectCard(container, card);
        });
        container.appendChild(card);
    });
}

// --- Step 7: Reservation Summary ---
function populateSummary() {
    const box = document.getElementById('reservation-summary-content');
    let packageHtml = '';
    let totalPrice  = 0;

    if (state.locationType === 'onsite') {
        if (state.miniPackage) {
            totalPrice += state.miniPackage.price;
            packageHtml += summaryRow('Package', `${state.miniPackage.label} — ₱${state.miniPackage.price.toLocaleString()}`);
            packageHtml += summaryRow('Inclusions', `${state.miniPackage.pax} • ${state.miniPackage.hours} • ${state.miniPackage.credit}`);
        }
        if (state.snackAddon) {
            totalPrice += state.snackAddon.price;
            packageHtml += summaryRow('Snack Bar Add-on', `${state.snackAddon.label} — ₱${state.snackAddon.price.toLocaleString()}`);
        }
    } else {
        if (isFoodTray()) {
            state.trayCart.forEach(item => {
                totalPrice += item.price;
                packageHtml += summaryRow(`${item.category} Tray (${item.pax} pax)`, `${item.dish} — ₱${item.price.toLocaleString()}`);
            });
        } else if (state.offsitePackage) {
            totalPrice = state.offsitePackage.price;
            const catLabel = offsiteCategories.find(c => c.value === state.offsiteCategory)?.label || '';
            packageHtml += summaryRow('Service', catLabel);
            packageHtml += summaryRow('Package', state.offsitePackage.label);
            if (state.offsitePackage.price > 0) {
                packageHtml += summaryRow('Price', `₱${state.offsitePackage.price.toLocaleString()}`);
            }
        }
    }

    const totalStr = totalPrice > 0 ? `₱${totalPrice.toLocaleString()}` : 'Contact for quote';

    box.innerHTML = `
        <p><span>Event Type</span> ${state.eventType}</p>
        <p><span>Date</span> ${state.eventDate}</p>
        <p><span>Time</span> ${state.time}</p>
        <p><span>Guests</span> ${state.guestCount}</p>
        <p><span>Location</span> ${state.locationType === 'onsite' ? '🏠 Onsite — ELI Coffee' : '🚗 Offsite — ' + state.venueLocation}</p>
        <hr class="summary-divider">
        ${packageHtml}
        <hr class="summary-divider">
        <p><span>Name</span> ${state.name}</p>
        <p><span>Email</span> ${state.email}</p>
        <p><span>Phone</span> ${state.phone}</p>
        ${state.requests ? `<p><span>Special Requests</span> ${state.requests}</p>` : ''}
        <hr class="summary-divider">
        <p class="summary-total"><span>Total:</span> ${totalStr}</p>
    `;

    const warning = document.getElementById('guest-warning');
    if (warning) warning.style.display = !isLoggedIn ? 'flex' : 'none';
}

function summaryRow(label, value) {
    return `<p><span>${label}</span> ${value}</p>`;
}

// ========================
// Validation
// ========================
function validateStep(n) {
    const stepId = getStepId(n);

    switch (stepId) {
        case 'step1': {
            const eventType  = document.getElementById('event-type').value.trim();
            const guestCount = document.getElementById('guest-count').value.trim();
            const dateVal    = document.getElementById('event-date').value;
            if (!eventType || !guestCount || !dateVal) {
                alert('Please fill in Event Type, Number of Guests, and Event Date.');
                return false;
            }
            const chosen = new Date(dateVal);
            const today  = new Date(); today.setHours(0, 0, 0, 0);
            if (chosen < today) { alert('Please select a future date.'); return false; }
            state.eventType  = eventType;
            state.guestCount = guestCount;
            state.eventDate  = dateVal;
            return true;
        }

        case 'step2': {
            if (!state.locationType) { alert('Please select Onsite or Offsite.'); return false; }
            if (state.locationType === 'offsite') {
                const v = document.getElementById('venue-location').value.trim();
                if (!v) { alert('Please enter your venue location.'); return false; }
                state.venueLocation = v;
            }
            return true;
        }

        case 'step3': {
            if (state.locationType === 'onsite') {
                if (!state.miniPackage) { alert('Please select a gathering package.'); return false; }
            } else {
                if (!state.offsiteCategory) { alert('Please select a service category.'); return false; }
                if (state.offsiteCategory !== 'foodtray' && !state.offsitePackage) {
                    alert('Please select a specific package.'); return false;
                }
            }
            return true;
        }

        case 'step4': {
            if (!state.trayCart.length) { alert('Please select at least one food tray dish.'); return false; }
            return true;
        }

        case 'step5': {
            const name  = document.getElementById('name').value.trim();
            const phone = document.getElementById('phone').value.trim();
            const email = document.getElementById('email').value.trim();
            if (!name || !phone || !email) { alert('Please fill in all required contact fields.'); return false; }
            if (!/^\S+@\S+\.\S+$/.test(email)) { alert('Please enter a valid email address.'); return false; }
            state.name     = name;
            state.phone    = phone;
            state.email    = email;
            state.requests = document.getElementById('requests').value.trim();
            return true;
        }

        case 'step6': {
            if (!state.time) { alert('Please select a time slot.'); return false; }
            return true;
        }

        case 'step7': {
            if (!isLoggedIn) {
                const w = document.getElementById('guest-warning');
                if (w) w.style.display = 'flex';
                return false;
            }
            return true;
        }

        case 'step8': {
            if (!document.getElementById('contract').files.length) {
                alert('Please upload your signed contract before submitting.');
                return false;
            }
            return true;
        }

        default: return true;
    }
}

// ========================
// Navigation
// ========================
nextBtn.addEventListener('click', () => {
    if (!validateStep(currentStep)) return;
    if (currentStep < getTotalSteps()) {
        currentStep++;
        showStep(currentStep);
    } else {
        submitReservation();
    }
});

prevBtn.addEventListener('click', () => {
    if (currentStep > 1) { currentStep--; showStep(currentStep); }
});

// ========================
// Submit
// ========================
function submitReservation() {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelector('.reservation-buttons').style.display = 'none';
    document.querySelector('.progress-container').style.display  = 'none';

    const success = document.createElement('div');
    success.className = 'summary-box';
    success.style.textAlign = 'center';
    success.style.padding   = '40px';
    success.innerHTML = `
        <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
        <h3 style="color: #2A1408; font-size: 20px; margin-bottom: 12px;">Reservation Submitted!</h3>
        <p style="color: #666; line-height: 1.8;">
            Thank you, <strong>${state.name}</strong>!<br>
            Your reservation is now <strong style="color: #6B3A1F;">under verification</strong>.<br>
            We will contact you at <strong>${state.email}</strong> to confirm your booking.
        </p>
    `;
    document.querySelector('.reservation-container').appendChild(success);
}

// ========================
// Step 2: Location Card Click
// ========================
document.querySelectorAll('#step2 .location-select-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('#step2 .location-select-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.locationType   = card.dataset.value;
        state.miniPackage    = null;
        state.snackAddon     = null;
        state.offsiteCategory = '';
        state.offsitePackage  = null;
        state.trayCart        = [];

        const venueWrapper = document.getElementById('venue-wrapper');
        if (state.locationType === 'offsite') {
            venueWrapper.classList.remove('hidden');
        } else {
            venueWrapper.classList.add('hidden');
        }
    });
});

// ========================
// Helpers
// ========================
function makeCard(innerHTML, isSelected = false) {
    const card = document.createElement('div');
    card.className = 'package-card' + (isSelected ? ' selected' : '');
    card.innerHTML = innerHTML;
    return card;
}

function makePill(text, isSelected = false) {
    const pill = document.createElement('div');
    pill.className = 'option-pill' + (isSelected ? ' selected' : '');
    pill.innerText = text;
    return pill;
}

function selectCard(container, activeCard) {
    container.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
    activeCard.classList.add('selected');
}

function selectPill(container, activePill) {
    container.querySelectorAll('.option-pill').forEach(p => p.classList.remove('selected'));
    activePill.classList.add('selected');
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

// ========================
// Initialize
// ========================
showStep(currentStep);


const MINI = [
    { label:'VIP Lite',        price:2999,  pax:'15–18 pax', hours:'2 hours', credit:'₱2,000 food credit', contract:'../files/contracts/contract-vip-lounge.pdf' },
    { label:'VIP Plus',        price:3999,  pax:'15–18 pax', hours:'3 hours', credit:'₱2,499 food credit', contract:'../files/contracts/contract-vip-lounge.pdf' },
    { label:'VIP Max',         price:4999,  pax:'15–18 pax', hours:'4 hours', credit:'₱3,000 food credit', contract:'../files/contracts/contract-vip-lounge.pdf' },
    { label:'Main Hall Basic', price:9999,  pax:'Up to 25 pax', hours:'2 hours', credit:'₱8,000 food credit', contract:'../files/contracts/contract-main-hall.pdf' },
    { label:'Main Hall Plus',  price:11999, pax:'Up to 25 pax', hours:'3 hours', credit:'₱9,000 food credit', contract:'../files/contracts/contract-main-hall.pdf' }
];

const OFFSITE_PKGS = {
    coffee: [
        { label:'30 pax',  price:3990,  desc:'...', contract:'../files/contracts/contract-coffee-bar.pdf' },
        { label:'50 pax',  price:5990,  desc:'...', contract:'../files/contracts/contract-coffee-bar.pdf' },
        { label:'100 pax', price:10990, desc:'...', contract:'../files/contracts/contract-coffee-bar.pdf' },
        { label:'150 pax', price:14990, desc:'...', contract:'../files/contracts/contract-coffee-bar.pdf' },
        { label:'Food Tray', val:'foodtray', icon:'🍱', desc:'...', contract:'../files/contracts/contract-food-tray.pdf' }
    ],
    snack:    [{ label:'...', price:3500, desc:'...', contract:'../files/contracts/contract-snack-bar.pdf' }],
    catering: [{ label:'...', price:0,    desc:'...', contract:'../files/contracts/contract-catering.pdf'  }]
};


function getContractUrl() {
    if (S.locationType === 'onsite') {
        return S.miniPackage?.contract || '';
    } else {
        if (S.offsiteCategory === 'foodtray') {
            const cat = OFFSITE_CATS.find(c => c.val === 'foodtray');
            return cat?.contract || '';
        }
        return S.offsitePackage?.contract || '';
    }
}
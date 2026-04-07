# 🚀 Digital Twin Dashboard (Remote Machine Monitoring & Control)

A real-time **Digital Twin Lab Dashboard** that enables both **monitoring and remote control** of machines such as **PocketNC (CNC)** and **FDM/Resin printers** from a centralized interface.

Built using **FastAPI, React (Vite), WebSockets, and Docker**, this system allows operators to interact with physical machines remotely through a live digital interface.

---

## 🧠 Features

* 🔴 Real-time machine monitoring (RPM, feed rate, positions)
* 🎮 Remote machine control (start, stop, pause, E-stop)
* 📡 Live WebSocket streaming from machines
* 📂 G-code upload and execution
* 📜 Active G-code tracking (live execution lines)
* 🎥 Live camera/video streaming
* 🖥️ Centralized dashboard UI
* 🔌 Multi-machine support (PocketNC, FDM, Resin)
* 🐳 Fully containerized (runs on any system using Docker)

---

## 🏗️ Architecture

```text
React UI (Control Panel)
        ↓
Nginx (Routing)
        ↓
FastAPI Backend (API + WebSocket)
        ↓
Command Layer (SSH / HTTP APIs)
        ↓
Machines (PocketNC / FDM / Resin)
```

This system enables **bi-directional communication**, allowing:

* 📥 Data streaming from machines
* 📤 Control commands sent to machines

---

## ⚙️ Tech Stack

### Frontend

* React + Vite
* TypeScript

### Backend

* FastAPI
* WebSockets
* Gunicorn + Uvicorn

### Infrastructure

* Docker
* Nginx

### Machine Integration

* SSH (PocketNC)
* Socket streaming (real-time data)
* Moonraker (FDM printers)

---

## 🚀 Getting Started

### 1️⃣ Install Docker

Install Docker Desktop:
https://www.docker.com/products/docker-desktop/

---

### 2️⃣ Clone the Repository

```bash
git clone <your-repo-url>
cd Digital-Twin-Dashboard
```

---

### 3️⃣ Run the Application

```bash
docker compose up --build
```

---

### 4️⃣ Open in Browser

```
http://localhost
```

---

## 🔧 Configuration

Create a `.env` file inside the backend folder:

```env
PRINTER_IP=your_machine_ip
SSH_HOST=your_machine_ip
```

⚠️ Do NOT commit `.env` files to GitHub

---

## 🧪 Development (Optional)

### Run backend locally

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

### Run frontend locally

```bash
cd frontend
npm install
npm run dev
```

---

## 🔄 Updating the Project

After making changes:

```bash
docker compose down
docker compose up --build
```

---

## 📡 Machine Setup (PocketNC)

On the machine:

```bash
cd ~/machinekit
source scripts/rip-environment
python stream.py
python control.py
```
The backend connects via socket/SSH to stream live data.

---

## ⚠️ Notes

* Requires network access to machines
* Update machine IP in `.env`
* WebSocket endpoints handled via Nginx

---

## 📌 Future Improvements

* Multi-machine scaling
* Redis for streaming buffer
* Database integration (PostgreSQL / TimescaleDB)
* Authentication & user roles
---

🎯 Key Capability

This is not just a monitoring dashboard.

👉 It a Digital Twin Control System, where users can:

Observe machine state in real-time
Send commands remotely
Execute jobs (G-code)
Control machine behavior from a centralized UI

This mirrors real-world industrial control room systems used in smart manufacturing.
---

## 👨‍💻 Author

**Preetham Reddy**
Computer Science @ Missouri S&T

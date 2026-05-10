# OffCom – Fully Offline Peer-to-Peer Voice Communication  

## Description  
OffCom is a lightweight, browser-based tool for **fully offline communication**. It removes reliance on internet or mobile data by using a host’s WiFi hotspot and works practically everywhere.


## Key Features  
- **Fully Offline**: Host runs a WiFi hotspot without mobile data/internet; all communication stays local.  
- **Long Range**: Operates on standard hotspot range (extends as far as your hotspot signal reaches).  
- **No Special Hardware**: Works on any device with a browser (tested on Android Chrome) and basic hotspot capabilities.
- **Mesh Architecutre**: Supports multiple guests with a full mesh connection.


## Limitations & Drawbacks  
- **No Persistence**: Connection drops if either device closes the browser tab.  
- **Unencrypted**: Data transmission is not encrypted (avoid on public/untrusted networks).  


## Getting Started  
### Step 1: Set Up the Host Server (Termux Required)  
OffCom needs an HTTPS server to run on Android (Chrome requires secure connections for local files). Use Termux to generate a certificate and start the server:  
```bash  
# 1. Generate SSL certificate (run once in the OffCom folder)  
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"  

# 2. Start the Python HTTPS server  
python3 signaling_server.py
```  
*Keep Termux open in the background, closing it stops the server.*  


### Step 2: Connect Devices  
1. **Host**: Enable WiFi Hotspot (no internet/mobile data needed).  
2. **Guest**: Connect to the host’s hotspot.  
3. **Both**: Open Chrome (other browsers may or may not work on Android) and navigate to:  
   `https://[host-phone-IP]:8443`  
   *(Find your host’s IP in Termux with `ip addr show wlan0`, look for `inet ` followed by a number like `192.168.43.1`. OR, go into wifi settings on the guest phone and search for "Router IP" there.)*  


### Step 3: Start Communication [1]  
- **Host**: Click "Create Room" and generate a QR code (you can send the room code manually as well).  
- **Guest**: Scan the QR code (or manually paste the room code) and you will automatically enter the room.
- **Host**: Click "Enter Call" and you're done!


## Usage Notes  
- **Browser Only**: Tested exclusively on Android Chrome (Brave might work 🤷).
- **Hotspot Stability**: Ensure the host’s hotspot is strong, range depends on device hardware and environment.  
- **No Background Use**: Keep the Chrome tab open on both devices; closing it ends the call.  

> [FYI]
> This is a solid base. But a native app would be better instead of adding more features to this, so no further updates will be made here.
---

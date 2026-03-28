import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
import os

print("Initializing Chrome for screenshot capture...")
chrome_options = Options()
chrome_options.add_argument("--headless")
chrome_options.add_argument("--window-size=1920,1080")

try:
    driver = webdriver.Chrome(options=chrome_options)
    url = "https://crm.globusdemos.com/expenses"
    print(f"Navigating to {url}")
    driver.get(url)
    time.sleep(4)  # Wait for React to render

    os.makedirs("e2e_screenshots", exist_ok=True)
    screenshot_path = "e2e_screenshots/fix_placeholder.png"
    driver.save_screenshot(screenshot_path)
    print(f"Screenshot saved to {screenshot_path}")
    driver.quit()
    print("Success.")
except Exception as e:
    print(f"Error: {e}")

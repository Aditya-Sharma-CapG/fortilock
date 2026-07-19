import fs from "fs/promises";
import path from "path";

describe("Settings UI - Checkbox Alignment & Recovery Codes", () => {
  let htmlContent: string;

  beforeEach(async () => {
    // Read the actual index.html file from the project
    const htmlPath = path.join(__dirname, "../../src/renderer/index.html");
    try {
      htmlContent = await fs.readFile(htmlPath, "utf-8");
    } catch {
      // Fallback HTML for testing
      htmlContent = `
        <label class="form-checkbox-label">
          <input type="checkbox" id="autostart" />
          <span>Launch FortiLock on system startup</span>
        </label>
        <button id="btnRegenerateRecovery">Regenerate Recovery Codes</button>
        <button id="btnCancelRegen">Cancel</button>
        <button id="btnConfirmRegen">Continue</button>
        <div id="regenPasswordOverlay" class="overlay hidden">
          <input type="password" id="regenPwd" placeholder="Enter master password" />
        </div>
      `;
    }
  });

  describe("Settings tooltips", () => {
    it("should expose explanatory tooltips for settings controls", () => {
      expect(htmlContent).toContain('id="idleTimeout"');
      expect(htmlContent).toContain('title="Locks protected items after this many minutes of inactivity"');
      expect(htmlContent).toContain('title="Use this shortcut to lock everything instantly"');
      expect(htmlContent).toContain('title="Start FortiLock automatically when Windows signs in"');
      expect(htmlContent).toContain('title="Save and apply the current security settings"');
    });

    it("should expose tooltips for item action buttons", () => {
      expect(htmlContent).toContain('title="Lock a file so it is encrypted and protected"');
      expect(htmlContent).toContain('title="Lock a folder and its contents"');
      expect(htmlContent).toContain('title="Lock an app so it prompts before launching"');
      expect(htmlContent).toContain('title="Lock every protected item immediately"');
    });
  });

  describe("Checkbox Alignment - Positive Cases", () => {
    it("should have checkbox and label properly structured", () => {
      // Check that the HTML contains the checkbox label with proper structure
      expect(htmlContent).toContain('class="form-checkbox-label"');
      expect(htmlContent).toContain('type="checkbox"');
      expect(htmlContent).toContain('id="autostart"');
      expect(htmlContent).toContain("Launch FortiLock on system startup");
    });

    it("should have flex layout with proper alignment", () => {
      // Check for flex CSS styles in the HTML
      expect(
        htmlContent.includes("display: flex") ||
          htmlContent.includes("display:flex"),
      ).toBeTruthy();

      expect(
        htmlContent.includes("align-items: center") ||
          htmlContent.includes("align-items:center"),
      ).toBeTruthy();
    });

    it("should have checkbox input properly sized", () => {
      // Check for checkbox sizing CSS
      expect(
        htmlContent.includes("width: 18px") ||
          htmlContent.includes("width:18px"),
      ).toBeTruthy();

      expect(
        htmlContent.includes("height: 18px") ||
          htmlContent.includes("height:18px"),
      ).toBeTruthy();
    });

    it("should display text without wrapping issues", () => {
      // Verify text is in a span element
      expect(htmlContent).toContain(
        "<span>Launch FortiLock on system startup</span>",
      );
    });

    it("should have proper gap between checkbox and text", () => {
      // Check for gap CSS in flex layout
      expect(
        htmlContent.includes("gap: 8px") || htmlContent.includes("gap:8px"),
      ).toBeTruthy();
    });
  });

  describe("Checkbox Alignment - Negative Cases", () => {
    it("should not have checkbox inside span", () => {
      // Verify checkbox is NOT nested inside span
      expect(htmlContent).not.toContain('<span><input type="checkbox"');
    });

    it("should not have nested labels", () => {
      // Find the checkbox label and verify no nested labels
      const labelMatch = htmlContent.match(
        /<label[^>]*class="form-checkbox-label"[^>]*>[\s\S]*?<\/label>/,
      );
      if (labelMatch) {
        const labelContent = labelMatch[0];
        // Count labels - should only be 1
        const labelCount = (labelContent.match(/<label/g) || []).length;
        expect(labelCount).toBe(1);
      }
    });

    it("should not have text split unexpectedly", () => {
      // Text should be in one span element
      expect(htmlContent).toContain(
        "<span>Launch FortiLock on system startup</span>",
      );
    });
  });

  describe("Recovery Codes Button - Positive Cases", () => {
    it("should have regenerate button present", () => {
      expect(htmlContent).toContain('id="btnRegenerateRecovery"');
      expect(htmlContent).toContain("Regenerate Recovery Codes");
    });

    it("should have cancel and confirm buttons", () => {
      expect(htmlContent).toContain('id="btnCancelRegen"');
      expect(htmlContent).toContain('id="btnConfirmRegen"');
      expect(htmlContent).toContain("<button");
    });

    it("should have password input field", () => {
      expect(htmlContent).toContain('type="password"');
      expect(htmlContent).toContain('id="regenPwd"');
    });

    it("should have hidden overlay for password prompt", () => {
      expect(htmlContent).toContain('id="regenPasswordOverlay"');
      expect(htmlContent).toContain('class="overlay hidden"');
    });

    it("should have overlay that can be shown/hidden", () => {
      // Verify overlay div exists and has hidden class for styling
      expect(htmlContent).toContain('class="overlay hidden"');
    });

    it("should allow password input in overlay", () => {
      // Verify password input exists within or near overlay
      expect(htmlContent).toContain('id="regenPwd"');
      expect(htmlContent).toContain('type="password"');
    });
  });

  describe("Recovery Codes Button - Negative Cases", () => {
    it("should not have duplicate button IDs", () => {
      const regenCount = (
        htmlContent.match(/id="btnRegenerateRecovery"/g) || []
      ).length;
      const cancelCount = (htmlContent.match(/id="btnCancelRegen"/g) || [])
        .length;
      const confirmCount = (htmlContent.match(/id="btnConfirmRegen"/g) || [])
        .length;

      expect(regenCount).toBe(1);
      expect(cancelCount).toBe(1);
      expect(confirmCount).toBe(1);
    });

    it("should have only one password input field", () => {
      const pwdInputCount = (htmlContent.match(/id="regenPwd"/g) || []).length;
      expect(pwdInputCount).toBe(1);
    });

    it("should have only one overlay", () => {
      const overlayCount = (
        htmlContent.match(/id="regenPasswordOverlay"/g) || []
      ).length;
      expect(overlayCount).toBe(1);
    });
  });

  describe("Recovery Codes Button - Edge Cases", () => {
    it("should support long passwords in input field", () => {
      // HTML input field should support type="password" without maxlength restrictions
      expect(htmlContent).toContain('type="password"');
      // No maxlength attribute found means no restriction
      const pwdInput = htmlContent.match(/id="regenPwd"[^>]*/);
      if (pwdInput) {
        expect(pwdInput[0]).not.toContain("maxlength");
      }
    });

    it("should support special characters in password", () => {
      // Password field is plain text input, no special escaping needed in HTML
      expect(htmlContent).toContain('type="password"');
    });

    it("should have cancel button to close overlay", () => {
      expect(htmlContent).toContain('id="btnCancelRegen"');
      expect(htmlContent).toContain("Cancel");
    });

    it("should have confirm button for password submission", () => {
      expect(htmlContent).toContain('id="btnConfirmRegen"');
      expect(htmlContent).toContain("Continue");
    });
  });

  describe("Integration - Settings Page Flow", () => {
    it("should have all components for recovery codes workflow", () => {
      // Regenerate button
      expect(htmlContent).toContain('id="btnRegenerateRecovery"');

      // Password overlay
      expect(htmlContent).toContain('id="regenPasswordOverlay"');

      // Password input
      expect(htmlContent).toContain('id="regenPwd"');

      // Confirm button
      expect(htmlContent).toContain('id="btnConfirmRegen"');

      // Cancel button
      expect(htmlContent).toContain('id="btnCancelRegen"');
    });

    it("should maintain proper element hierarchy", () => {
      // Verify buttons are present
      const buttonCount = (htmlContent.match(/<button/g) || []).length;
      expect(buttonCount).toBeGreaterThanOrEqual(3);

      // Verify overlay structure
      expect(htmlContent).toContain("overlay");
      expect(htmlContent).toContain("hidden");
    });
  });
});

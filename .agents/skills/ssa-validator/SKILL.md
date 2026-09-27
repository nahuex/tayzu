---
name: ssa-validator
description: >-
  Complete Security Self-Assessment (SSA) Validator skill for the VCDM agent.
  Covers all 16 security sections (SEC01 through SEC16): System Diagram,
  Attack Surfaces, Access Control, Password Storage, Cryptography, Application
  Misuse, Software Dependencies, File Upload, Secrets in Code, Secret
  Management, Phishing, Testing and QA, Secure Deployment, Infrastructure
  Permissions, Network and Host Security Basics, and Security Logging.
  The agent uses this skill to guide users step-by-step through each section,
  verifying requirements, checklists, best practices, and anti-patterns,
  and ensuring improvement tickets are created for any identified gaps.
  Sections SEC11 through SEC16 are in the companion file SEC11-SEC16.md
  located in this same skill folder.
---

# SSA Validator - Full Security Self-Assessment Skill (VCDM Agent)

This skill instructs the VCDM agent on how to conduct a complete Security
Self-Assessment (SSA) covering sections SEC01 through SEC16. Each section
contains the agent primary directives, assessment questions (Q&A), mandatory
self-review checklists, best practices, anti-patterns, and a step-by-step
execution flow.

**Agent Global Directives:**
- Never skip or omit any item from any checklist, question, or section.
- If a user selects an option ending in "(create ticket)", halt the flow and
  confirm the user will create and link an improvement ticket before proceeding.
- If a user selects an option requiring justification, prompt them to type it.
- Generate a final summary report at the end of each section.
- Sections SEC11 through SEC16 are defined in SEC11-SEC16.md in this folder.

---

# Skill: SEC01 - System Diagram Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill enables the AI agent to guide the user in creating, reviewing, and validating a high-level system diagram according to the SEC01 strict requirements, mandatory self-review checklists, and recommended best practices.
**Goal:** Ensure the system diagram accurately depicts the system, all interacting actors, boundaries, and complies with all security posture standards.

---

## 1. Primary Directives for the Agent
- **Do not omit information:** You must verify every single point in the requirements, self-review checklist, and best practices before marking SEC01 as complete.
- **Iterative Review:** Ask the user to provide their system diagram (or its description/metadata) and cross-reference it against the lists below.
- **Identify Gaps:** If any checklist item is missing, explicitly point it out to the user and request a correction or confirmation.

---

## 2. General Requirements (To be validated)
The agent must ensure the user understands and applies the following requirements to their System Diagram:

1. The system diagram should be added to the SSA as an image (jpg or png).
2. There should be one diagram for the whole product.
3. The diagram should only include components that are under the product's responsibility.
4. All major logical components (see definition below) in the system diagram that are part of the product should be grouped inside a (box) border (dotted line or similar).
5. The diagram must include the name of the product.
6. The diagram can be done with any tool but draw.io is recommended.
7. The diagram should display the product in the middle and all actors (see definition below) around it.
8. The diagram should show the product with all its intended/designed interactions. Must include the deployment pipeline and the centralized logging system.
9. All designed network interaction between the actors and the major components (interfaces) should be visible in the diagram by using arrows.
10. Arrows should only go from the initiator to the target. Response is assumed. If both initiates interaction then the arrow should be pointing towards both external and major components.
11. All arrows should include the protocol used for communication. If it's configurable by the customer, then it should include the default protocol.

### Definitions to provide to the user:
**Actors:** Any human or system that is interacting with any of the product interfaces.
*Examples:* 
- Integrating systems (e.g., AutoPay, AutoInvoice, Connect)
- Integrating support systems (e.g., Google Analytics, Hotjar, AppDynamics, Crowdin, Sendgrid, licensing and invoicing systems, logging and monitoring systems)
- Deployment channel(s)
- End users (humans)
- Support users (humans)
- Operational users (humans)
- Developers (humans)

**Major Logical Components:** All major parts that make up the product.
*Examples:* 
- Databases
- Web applications
- APIs
- Queues
- File storage (blob storage, S3 buckets etc)

---

## 3. Mandatory Self-Review Checklist (22 Items)
The agent must confirm all of the following checkboxes are verified (or not applicable but justified):

- [ ] All attack surfaces documented in SEC02 are visible with the same name in the system diagram.
- [ ] All major logical components on your responsibility are in the diagram.
- [ ] Components on your responsibility are grouped inside a border and the group has the name of your product. *(Note: The border is one of your trust boundaries. All traffic coming into the box should be considered as attack surface).*
- [ ] **AI Specific:** If your system uses AI or ML, all AI-specific and related components (e.g., AI services, LLMs, vector databases, RAG pipelines, agents and MCPs) and their interactions are visible in the system diagram.
- [ ] Actors: End-users, Administrators, Developers / Support / Operations are added into the diagram. *(Consider also DevOps access to infrastructure).*
- [ ] Actors: Integrations from external systems are visible in the diagram. *(External APIs, Mobile application).*
- [ ] In case there is a native mobile application it is visible in the diagram.
- [ ] Supporting systems: Integrations to external systems visible in the diagram.
- [ ] Supporting systems: Logging and analytics systems are visible in the diagram.
- [ ] Supporting systems: Deployment channels are visible in the diagram.
- [ ] Network: All network interactions are shown as arrows in the diagram. *(Arrows are pointing from initiator to target. Response is assumed).*
- [ ] Network: All arrows for internal interactions are visible.
- [ ] Network: All arrows for external interactions are visible (actors and interfaces).
- [ ] Network: All arrows contains protocol for communication.
- [ ] **AI Specific:** If your system uses AI, check more information on Responsible AI Guidelines.
- [ ] You have verified and updated any open improvement items from previous year.
- [ ] Improvement tickets have been created and linked to the assessment for all the improvements identified.

*(Agent Note: Ensure to ask the user to confirm all 22 items as completed, parsing through the list above).*

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read, acknowledged, and implemented where possible:

- [ ] **Include all parts of the software, infrastructure and third party services which are used in production.** 
  *Reasoning:* By making all parts visible it is easier to identify places to improve the security posture. For example, including all logical components you could find some legacy service that is not maintained any more.
- [ ] **Strive for end to end encrypted communication. Use internal cluster encryption for the data in transit.**
  *Reasoning:* Evil actors within an organisation of traffic in transit might be able to perform a man in the middle attack and sniff confidential information (e.g., authentication factors like passwords).
- [ ] **Data at rest is encrypted by using either platform managed or customer managed keys.**
  *Recommendation:* When possible the actual data should be encrypted for example in case of Microsoft SQL by using the always encrypted functionality.
- [ ] **Use just in time and just enough administration to interact with production infrastructure.**
- [ ] **Don't use shared accounts; always use personal accounts and log the important functionality.**

---

## 5. Execution Flow for VCDM Agent
1. **Initialize:** Greet the user and state the objective (Reviewing SEC01 - System Diagram).
2. **Present Requirements:** Briefly summarize the general requirements and ask the user to upload or describe their diagram.
3. **Iterative Verification (The Core):** Go through the 22-item checklist. You can group them logically (e.g., Actors, Network, AI, Boundaries) to avoid overwhelming the user, but *do not skip any*.
4. **Best Practices Acknowledgment:** Present the green "Best Practices" section and ask the user to acknowledge them or explain how they meet them.
5. **Final Output:** Generate a summary report stating what passes, what is missing, and if any improvement tickets need to be created based on gaps found during the process.


---

# Skill: SEC02 - Attack Surfaces Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill enables the AI agent to guide the user in identifying, documenting, and validating all attack surfaces based on the system diagram, ensuring strict compliance with SEC02 requirements, best practices, and avoiding known anti-patterns.
**Goal:** Ensure all attack surfaces are properly documented, authenticated, authorized, and mapped exactly as they appear in the system diagram.

---

## 1. Primary Directives for the Agent
- **Do not omit information:** You must verify every single point in the requirements, self-review checklist, best practices, and anti-patterns before marking SEC02 as complete.
- **Cross-Reference:** Ensure the user refers back to their System Diagram (from SEC01). The names and components must match exactly.
- **Identify Gaps:** If any checklist item is missing or an anti-pattern is detected, explicitly point it out to the user and request a correction.

---

## 2. General Requirements (To be validated)
The agent must ensure the user documents all attack surfaces in a table based on the system diagram, following these rules:

1. All attack surfaces from the system diagram should be documented in this table.
2. Use the same name in the table as you have done in the system diagram for easy identification.
3. Provide a short description of the functionality of the attack surface.
4. An attack surface is consumed by an actor, which can be either a human or a system.

### Definitions to provide to the user:
**Examples of actors:**
- Customer accessing a website.
- Third party system (ex bank) consumes the API of a product.
- Employees/system access the internal database for reporting or data warehouse purposes.
- Development team or support personnel accessing the system internal components/infrastructure for debugging or customer support purposes.

**Authentication:** The process of verifying who someone is (either human or system user).
*Examples:* Local username/password + 2fa, Username/password from authentication provider, Personal certificate, API key.

**Authorization:** The process of verifying what the users have access to.
*Examples:* Groups, Roles, Scopes.

---

## 3. Mandatory Self-Review Checklist
The agent must confirm all of the following checkboxes are verified by the user:

- [ ] All the attack surfaces corresponding to all incoming arrows starting from external actors (human or system) are documented in the table. *(Consider as attack surfaces any direct access to a FTP server or to a database or storage).*
- [ ] **AI Specific:** If your system uses AI or ML, all attack surfaces (AI attack surface) related to AI/ML are identified from the diagram and are listed in the table. *(Consider all interactions from AI as an attack surface).*
- [ ] All attack surfaces documented in this section are visible with the same name in the system diagram.
- [ ] All attack surfaces have a short description of the functionality.
- [ ] Each attack surface has all actors specified. *(Systems/human actors, who have access to the interface. Categorise the actors as detailed as possible, e.g., admin users vs. support users).*
- [ ] Authentication mechanism is described for all attack surfaces.
- [ ] Authorization mechanism is described for all attack surfaces.
- [ ] Short description of the technology which is used to create the functionality of the attack surface. *(E.g., Angular, .Net 7, OIDC).*
- [ ] Any native mobile application should be considered as attack surface. How does the mobile application authenticate towards the web server? *(Reference: OWASP Mobile Application Security Guidelines).*
- [ ] Consider implementing extra security for any administration API endpoint that the team uses for service configuration. *(Role based access control, time based access control, firewall rules).*
- [ ] Verify that any new attack surfaces introduced since the last assessment review have been added to the diagram and the table.
- [ ] You have verified and updated any open improvement items from previous assessments.

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] 2FA/MFA should be required/enforced for all human/user access.
- [ ] Favor STRONG authentication factors like Electronic ID and Passkeys over WEAKER ones like email and password.
- [ ] DevOps should access the infrastructure using privileged access management tools.
- [ ] All applicable attack surfaces should be authenticated and authorized.
- [ ] Make sure customer data is segregated and the customer can only access their data.
- [ ] Use short lived tokens to authorize the access, like JWT with short lifetime.
- [ ] Remember to verify the audience, expiration and the signature of the token.
- [ ] **AI Specific:** Treat the AI as a user, not a backend. Assume that all data from AI is untrusted and create the defences to all AI integrations accordingly.
- [ ] **AI Specific:** Enforce strict least privilege for all AI tools. Avoid long-lived, broadly scoped API keys. Utilize short-lived tokens to minimize the window of compromise.

---

## 5. Anti-patterns (Read and Acknowledge)
The agent must warn the user about these anti-patterns and verify they are not present in the system:

- [ ] **Legacy Code:** Having code for legacy functionality which is deprecated can lead to unnecessary vulnerabilities. *(For example: old authentication/authorization mechanisms, old API versions, etc.)*
- [ ] **Shared API Keys:** Using the same API key with multiple customers. *(By using the same API key you can’t verify which customer is consuming the API, compromising accountability. If the API key is leaked all customer installations are compromised and the key needs to be changed for everyone).*

---

## 6. Execution Flow for VCDM Agent
1. **Initialize:** State the objective (Reviewing SEC02 - Attack Surfaces) and ask the user to provide their documented table of attack surfaces.
2. **Cross-Check with SEC01:** Remind the user that the names in this table must perfectly match the boundaries and components drawn in the SEC01 System Diagram.
3. **Iterative Verification:** Run through the Mandatory Checklist, asking the user to confirm the presence of descriptions, actors, authentication/authorization mechanisms, and technologies for *every single* attack surface.
4. **Enforce AI & Mobile Rules:** Pay special attention to AI pipelines or mobile apps if they exist, enforcing the specific AI and OWASP guidelines mentioned.
5. **Acknowledge Best Practices & Anti-patterns:** Present the green (Best Practices) and red (Anti-patterns) sections. The user must confirm they comply with the best practices and do not incur in the anti-patterns.
6. **Final Output:** Generate a summary report for SEC02, detailing approved attack surfaces and highlighting any missing documentation or vulnerabilities that require improvement tickets.


---

# Skill: SEC03 - Access Control Quality Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill enables the AI agent to guide the user through the Access Control Quality assessment. The agent will ask specific questions with predefined options, verify code review actions, and ensure compliance with best practices and anti-patterns.
**Goal:** Verify that all endpoints that need Access Control have it properly implemented to ensure confidentiality and integrity.

---

## 1. Primary Directives for the Agent
- **Strict Questioning:** You must ask the 5 specific questions (Q1 to Q5) exactly as they are written and present the user with the *exact* options provided below.
- **Dependency on Code Review:** Remind the user that answering these questions requires a smaller review of their code.
- **Enforce Actionable Answers:** If the user selects an option that includes "(create ticket)", you must explicitly instruct them to create an improvement ticket and link it to the assessment. If they select an option requiring justification, you must ask them for that justification.

---

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these 5 questions. Do not proceed to the next question until a valid option is selected for the current one.

### **Q1: Can a user only access the data that the user is intended to access?**
*Agent Context: Do a smaller review of code. Make sure that you always check that a user has the necessary permissions BEFORE fulfilling the request.*
**Options:**
1. Review done and end user permissions are always verified
2. Review done and end user permissions are NOT (always) verified (create ticket)

### **Q2: Provide a list of all access control security verifications conducted during this review. Create actions for any findings.**
*Agent Context: Prompt the user to provide a text list. Provide these examples to the user if they need guidance:*
- verify that sensitive data and APIs are protected against Insecure Direct Object Reference(IDOR) attacks
- verify that the application or framework enforces a strong anti-CSRF mechanism to protect authenticated functionality
- verify that administrative interfaces use appropriate multi-factor authentication
- verify that the mobile application performs local authentication securely according to the platform best practices
- create unit and integration tests cases for authorization logic
- verify that the application does not rely on easily guessed ids or even GUIDs. (OWASP IDOR Cheat Sheet)
- Find more in the OWASP Authorization Cheat Sheet

### **Q3: Where are Access Control checks done?**
*Agent Context: Client side controls can easily be bypassed but useful from a user experience view.*
**Options:**
1. Server side only
2. Server and Client side only for user experience
3. Client side only (create ticket)
4. No Access Control checks done (create ticket)
5. N/A (add justification as comment below)

### **Q4: If a developer forgets to configure Access Control rules for a new resource, will it fail securely (access denied)?**
*Agent Context: Secure by default.*
**Options:**
1. Yes
2. No (create ticket)
3. No, ticket not needed after consideration (add justification as a comment below)

### **Q5: Does the application have implemented support for risk-based (step-up or adaptive) authentication for high-risk functionality?**
**Options:**
1. Yes
2. No (create ticket)
3. No, ticket not needed after consideration (add justification as comment below)

---

## 3. Mandatory Self-Review Checklist
The agent must confirm all of the following checkboxes are verified by the user after completing the questions:

- [ ] Q1: A small code review has been done before answering this question and tickets created for any improvements found. *(Improvement tickets are linked as actions under this question).*
- [ ] Q2: As part of the code review done, you've conducted various investigations. Refer to the examples section for possible verifications and list the ones you've performed. *(These are just examples; other investigations are possible too).*
- [ ] Q4: If access control is not following the secure by default principle, creating an improvement ticket has been considered.
- [ ] Consider having an off-boarding process also for the internal users who have access to the system. *(E.g. Support personnel, Developers with accounts for accessing the application, Admins with accounts for accessing the infrastructure).*
- [ ] You have verified and updated any open improvement items from previous year.

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] **Q1:** Access control on endpoint level is in place.
- [ ] **Q1:** Access control on data level is in place.
- [ ] **Q3:** Access control done at server side. Only user experience related controls are done on the client side.
- [ ] **Q4:** Deny by default behaviour is enforced throughout the system. *(When a system follows the "deny by default" principle, it means that by default, no access or permissions are granted unless they are specifically allowed).*
- [ ] **Q5:** Requiring MFA when the user logs in from a new device, location, or network.
- [ ] **Q5:** Requiring MFA for administrative actions, high-risk functionality, changing security settings.

---

## 5. Anti-patterns (Read and Acknowledge)
The agent must warn the user about this anti-pattern and verify it is not present in the system:

- [ ] The system has multiple ways to do the access control or the access control is scattered all over the code.

---

## 6. Execution Flow for VCDM Agent
1. **Initialize:** State the objective (Reviewing SEC03 - Access Control Quality).
2. **Q&A Execution:** Ask questions Q1 through Q5 sequentially. Present the exact options provided. Wait for the user's response before proceeding to the next question.
3. **Handle Conditional Logic:** If a user selects an option ending in "(create ticket)", halt the flow briefly to confirm they understand an improvement ticket must be created. If they select "(add justification...)", prompt them to type their justification.
4. **Self-Review Checklist Verification:** Run through the 5 items in the checklist to confirm code reviews and investigations were actually performed.
5. **Acknowledge Best Practices & Anti-patterns:** Present the green (Best Practices) and red (Anti-patterns) sections. The user must confirm they comply.
6. **Final Output:** Generate a summary report for SEC03, detailing the answers given, the justifications provided, and clearly listing any required improvement tickets generated during the assessment.


---

# Skill: SEC04 - Password Storage Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user through the Password Storage assessment. The agent will ask specific questions about where and how end-user passwords are stored, ensuring compliance with secure hashing methods and identifying potential vulnerabilities.
**Goal:** Verify that human user passwords are protected and stored securely, emphasizing that encryption is not recommended compared to secure one-way hashing methods.

---

## 1. Primary Directives for the Agent
- **Strict Questioning:** Ask the 2 specific questions (Q1 and Q2) exactly as written and provide the exact options.
- **Contextual Guidance:** Remind the user that passwords belonging to customers should be stored via a secure one-way hashing method, and encryption is not recommended as it allows finding out the password.
- **Handling Insecure Storage:** If the user selects "Stored within the application database/file" in Q1 and then selects "Encrypted" or "Clear text" in Q2, the agent must strongly advise creating an improvement ticket.

---

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions sequentially.

### **Q1: Where are the end users passwords stored? (For other secrets see SEC09-10)**
*Agent Context: Select all that apply.*
**Options:**
1. Internal Authentication Provider such as Visma Connect, ODP
2. External Authentication Provider such as Google, Azure
3. Stored within the application database/file
4. Other system, please specify below

### **Q2: If stored within the application, how are the end users passwords stored?**
*Agent Context: Only ask this question if option 3 ("Stored within the application database/file") was selected in Q1, or if it's relevant based on the "Other system" response.*
**Options:**
1. Encrypted
2. Hashed
3. Clear text
4. N/A

---

## 3. Mandatory Self-Review Checklist
The agent must confirm the following checkboxes are verified by the user:

- [ ] Q1: Select all end-user password storages that are implemented in your application. *(For example, if you have in-application passwords and you are also using Visma Connect Idp, select 'Internal Authentication Provider' and 'Stored within the application database/file').*
- [ ] You have verified and updated any open improvement items from previous year.

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] **Q1:** Old unused/deprecated authentication mechanisms are disabled and removed. *(This could provide a back door into your system).*
- [ ] **Q2:** Passwords are securely hashed and salted (e.g. with Argon2). *(Reference: OWASP Password storage guidelines).*

---

## 5. Anti-patterns (Read and Acknowledge)
The agent must warn the user about this anti-pattern and verify it is not present in the system:

- [ ] After migrating from one identity provider (internal or external) to another, the system allows authentication for the SAME user account with both the old and the new identity provider. *(This could provide a back door into your system that the user is not aware of).*

---

## 6. Execution Flow for VCDM Agent
1. **Initialize:** State the objective (Reviewing SEC04 - Password Storage). Provide the context that protecting human user passwords is crucial and refer them to the OWASP Password Storage Cheat Sheet.
2. **Q&A Execution:** Ask Q1. Depending on the answer (specifically if stored within the application), ask Q2. 
3. **Analyze Responses:** If the answer to Q2 is "Encrypted" or "Clear text", the agent must flag this as a critical security issue and prompt the user to create a high-priority improvement ticket to implement secure hashing (e.g., Argon2).
4. **Self-Review Checklist Verification:** Verify the 2 checklist items.
5. **Acknowledge Best Practices & Anti-patterns:** Present the green (Best Practices) and red (Anti-patterns) sections. The user must confirm compliance.
6. **Final Output:** Generate a summary report for SEC04, detailing the password storage mechanisms identified, acknowledging the review of best practices, and listing any required improvement tickets (especially for insecure storage methods).


---

# Skill: SEC05 - Crypto/hash Algorithms Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user to document and validate all cryptographic and hashing algorithms used within their system. The agent ensures the user relies on modern, secure algorithms, avoids custom implementations, and properly assesses their TLS posture.
**Goal:** Mitigate risks by ensuring cryptography is securely implemented using known, modern algorithms, and that obsolete algorithms (like MD5 or SHA-1) are identified for upgrade.

---

## 1. Primary Directives for the Agent
- **Emphasize Table Completion:** The core of this section requires the user to document their cryptography usage in a specific table format. You must ask them to provide this data.
- **Identify Obsolete/Custom Algorithms:** Actively look for mentions of DES, 3DES, MD5, SHA-1, or any custom-built algorithms in the user's input. If found, strictly instruct the user to create an improvement ticket.
- **TLS Posture Enforcement:** If the product uses TLS, ensure the user has assessed it (e.g., using SSL Labs SSLTest) and that TLS 1.0 and 1.1 are not supported.

---

## 2. General Requirements (To be validated)
The agent must ensure the user documents what crypto/hash algorithms their system uses/supports. If the product is using TLS, it must be listed.

The agent must prompt the user to provide the following information for *each* usage of cryptography:
1. **For what purpose are you using cryptography?**
2. **Usage**
3. **Type**
4. **Crypto/hash Algorithm**
5. **Key Length**
6. **Key Storage**
7. **Cryptographic Library Used**

*(Agent Note: Guide the user to references like OWASP Password Hashing Algorithms and Cryptographic Storage Cheat Sheet if they need help determining secure options).*

---

## 3. Mandatory Self-Review Checklist
The agent must confirm all of the following checkboxes are verified by the user:

- [ ] TLS encryption is visible on a separate row and the minimum allowed TLS version is specified. *(TLS 1.0 and 1.1 should not be supported anymore).*
- [ ] For all public endpoints TLS posture is checked with SSL Labs SSL test and any needed improvements tickets have been created. *(Check for weak ciphers, HSTS response header recommendations).*
- [ ] All usage of cryptographic algorithms are listed. *(e.g., database encryption, JWT verification algorithm, password hashing, signing of the data, hashing, asymmetric encryption, symmetric encryption, random number generation).*
- [ ] If custom encryption or hashing algorithms are used, an improvement ticket is created to change the algorithm with a well-known and secure one.
- [ ] You have checked that the list of crypto/hash algorithms is not containing any unsecure or obsolete algorithms. *(e.g., DES, 3DES, MD5).*
- [ ] You have checked that the configuration of the algorithm and the length of the keys are secure. *(Reference: OWASP Cryptographic Storage guidelines).*
- [ ] You have verified and updated any open improvement items from previous year.
- [ ] You have created any needed improvement tickets and linked them in the assessment.

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] Use known and secure crypto algorithms. *(References: OWASP Cryptographic storage Cheat Sheet, OWASP Password storage Cheat Sheet).*

---

## 5. Anti-patterns (Read and Acknowledge)
The agent must warn the user about this critical anti-pattern and verify it is strictly avoided:

- [ ] **Use of custom algorithms:** Creating secure and well-tested crypto algorithms is extremely hard. Please use known and secure algorithms instead.

---

## 6. Execution Flow for VCDM Agent
1. **Initialize:** State the objective (Reviewing SEC05 - Crypto/hash algorithms) and emphasize the importance of using modern hashing and encryption methods.
2. **Data Collection (Table):** Prompt the user to provide their cryptographic usage data according to the 7 required columns (Purpose, Usage, Type, Algorithm, Key Length, Key Storage, Library). 
3. **Validation & Analysis:** Analyze the provided data. If the agent detects 'MD5', 'SHA-1', 'DES', '3DES', or notes indicating 'custom algorithm', immediately halt and instruct the user to create an improvement ticket.
4. **Self-Review Checklist Verification:** Run through the checklist, paying special attention to the TLS posture check requirement via SSL Labs.
5. **Acknowledge Best Practices & Anti-patterns:** Present the green (Best Practices) and red (Anti-patterns) sections.
6. **Final Output:** Generate a summary report for SEC05, detailing the accepted cryptographic implementations and clearly highlighting any identified obsolete or custom algorithms that require improvement tickets.


---

# Skill: SEC06 - Application Misuse Assessment (Combined Parts 1 and 2)

**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user through the Application Misuse assessment. It evaluates how the system protects users against general misuse scenarios, financial data manipulation, business logic flaws, and specifically addresses prompt injection and AI output sanitization.
**Goal:** Ensure the product is designed to react to security failures ("Assume breach") and that robust technical fences are in place, particularly for AI components, to prevent prompt injection and unvalidated outputs.

---

## 1. Primary Directives for the Agent
- **Assume Breach Mentality:** Remind the user that given today's threat landscape, they should always assume a breach[cite: 35]. Security controls sometimes fail, and the product must be designed to react[cite: 35].
- **Strict Questioning:** Ask questions Q1 through Q3 (Application Misuse) and Q1 through Q2 (AI Application Misuse) exactly as written, providing the specific options. Allow multiple selections where appropriate.
- **Enforce Tickets:** If an option ending in "(create ticket)" or "(consider ticket)" is selected, explicitly instruct the user to create an improvement ticket.

---

## 2. Assessment Questions: Application Misuse (Q&A Flow)

### **Q1: General misuse scenarios (assume the users credentials have been phished), select all implemented:**
*Agent Context: Allow the user to select multiple options.*
**Options:**
- User management not part of the systems functionality (user management part of integrated service (Connect, ODP, Visma Online etc))[cite: 36]
- Change of email address (e.g. notify or verify)[cite: 36]
- Enabling/disabling of 2FA (e.g. notify)[cite: 36]
- Password changes (e.g. notify)[cite: 36]
- Unusual login from suspicious geo-location (e.g. notify, limit or block)[cite: 36]
- None (create ticket)[cite: 36]

### **Q2: Systems that handle financial data, select all implemented:**
*Agent Context: Allow the user to select multiple options.*
**Options:**
- Modification of bank account details[cite: 37]
- Large payments (exceeding a certain threshold)[cite: 37]
- Payments to unusual countries[cite: 37]
- Other scenarios implemented (please describe)[cite: 37]
- N/A[cite: 37]
- None (create ticket)[cite: 37]

### **Q3: Business/application logic misuse scenarios, select all implemented:**
*Agent Context: Allow the user to select multiple options.*
**Options:**
- Obvious Cross-Site Scripting (XSS) or SQL injection (SQLi) payloads[cite: 38]
- Multiple input validation or business logic verification failures with values that cannot be the result user mistakes or typos[cite: 38]
- Attempts to bypass presentation layer/frontend input validation[cite: 38]
- Using the application faster than would be possible without automation tools[cite: 38]
- Large number of, or high rate of use of, application-specific functionality (e.g. voucher code submission, failed credit card payments, file uploads, file downloads etc).[cite: 38]
- Accessing a multi-stage business process in the wrong order[cite: 39]
- Geo-location change of a user during a session[cite: 39]
- None (create ticket)[cite: 39]

---

## 3. Assessment Questions: AI Application Misuse (Q&A Flow)

*Agent Context regarding AI Security:* Relying on instructions like “Behave nicely” is not a security strategy[cite: 40]. Mature products build strong technical fences: filtering inputs to block prompt injection, validating all outputs, and enforcing least privilege[cite: 40]. Multi-agent systems pose risks if the workflow becomes a black box; a single compromised agent can corrupt the workflow[cite: 40]. Architecture must enforce strict chain of command and maintain a unified audit trail[cite: 40].

### **Q1: How does the team ensure detection and mitigation of prompt injection?**
*Agent Context: Allow the user to select multiple options.*
**Options:**
- We implement 3rd party AI security solution (Azure AI Content Safety, Google Model Armor, Lakera Guard, etc.) to monitor and filter malicious inputs[cite: 41]
- We use output validation to ensure the LLM's response adheres to expected formats and rules[cite: 41]
- We have a human-in-the-loop approval process for any sensitive actions (e.g. initiating payments, modifying financial records or personal data) triggered by a prompt[cite: 41]
- We test specifically for direct, indirect, and tool description injection vulnerabilities[cite: 41]
- We rely primarily on instructions in the system prompt to control the AI's behavior, without any technical enforcement or segmentation. (create ticket)[cite: 42]
- Other. Please describe[cite: 42]
- N/A[cite: 42]

### **Q2: How does the application handle and sanitize outputs from the AI?**
*Agent Context: Allow the user to select multiple options.*
**Options:**
- All LLM output is treated as untrusted and is strictly validated and/or encoded before being used by downstream systems (e.g. to prevent XSS, SQL injection, html or markdown injection, etc.)[cite: 43]
- Strict CSP rules are implemented to enforce an explicit allowlist of trusted domains ensuring that even if an AI is manipulated, it cannot load external images or resources used to smuggle data out of the session[cite: 43]
- Only plain text output is allowed[cite: 43]
- Some outputs are validated, but coverage is inconsistent (consider ticket)[cite: 43]
- We pass the LLM output directly to downstream functions without sanitization (create ticket)[cite: 44]
- N/A[cite: 44]

---

## 4. Execution Flow for VCDM Agent
1. **Initialize:** Present the "Assume breach" philosophy and the importance of anticipating misuse[cite: 35].
2. **General Misuse Q&A:** Guide the user through Q1, Q2, and Q3 regarding general application misuse. Ensure they consider all relevant options.
3. **AI Security Briefing:** If the system uses AI, explain the necessity of technical fences over simple prompt instructions[cite: 40], and the risks of compromised agents in multi-agent systems[cite: 40].
4. **AI Misuse Q&A:** Guide the user through Q1 and Q2 regarding AI prompt injection and output sanitization.
5. **Ticket Enforcement:** Flag any selections requiring tickets and ensure the user commits to creating them.

**Agent Role:** Security Self Assessment (SSA) Validator - VCDM

---

## 3. Assessment Questions: AI Application Misuse (Q&A Flow - Continued)

### **Q3: What controls are in place to mitigate the risks agents and tools can introduce?**
*Agent Context: Allow the user to select multiple options.*
**Options:**
- The agents and AI's tools operate under the principle of least privilege, with the minimum permissions necessary[cite: 45]
- The agents and AI's tools are authorized with users permissions to limit the access to users access scope only[cite: 45]
- High-risk actions (e.g. modifying or deleting data, executing code, sending messages) require explicit human approval[cite: 45]
- We maintain a strict, reviewed inventory of all tools available to the agent[cite: 45]
- We prohibit or heavily restrict open-ended tools (e.g., shell access, arbitrary file I/O)[cite: 45]
- We implement sandboxing for any code execution tools to limit their blast radius and prevent lateral movement[cite: 46]
- Other. Please describe[cite: 46]
- N/A[cite: 46]

---

## 4. Mandatory Self-Review Checklist (27 Items Total)
The agent must confirm all of the following checkboxes are verified by the user:

- [ ] Q1: All the scenarios for which you have mitigation in place are selected.[cite: 47]
- [ ] Q2: If the system is handling financial data you have verified what mitigations are already implemented and selected the corresponding values as answers.[cite: 47]
- [ ] Q3: You have verified for what misuse scenario you have mitigations implemented and selected the corresponding values as answers.[cite: 47]
- [ ] Q3: Does the ORM that you use have support for protection against SQL-injection. (Reference: OWASP ORM Injection testing)[cite: 47]
- [ ] Q3: Does the front-end framework you use have support for protection against XSS-attacks.[cite: 47]
- [ ] You have read all the misuse options in the questions. (Some of the dropdowns are scrollable)[cite: 47]
- [ ] You have created follow up Jira cases for implementing mitigations for the applicable misuse scenarios you don’t have verification already implemented.[cite: 48]
- [ ] You have verified and updated any open improvement items from previous year.[cite: 48]
- [ ] AI: You have verified what controls are implemented into AI, its agents and tools to prevent malicious use of AI[cite: 48]
- [ ] AI-Q3: You have verified that AI and its agents and tools are using minimum permissions necessary[cite: 48]
- [ ] AI-Q3: Consider creating ticket for answer options you haven't implemented[cite: 48]

---

## 5. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] Q1: User is notified or the change is verified whenever the user email address is being changed in the application. (This way an attacker can’t redirect to their own account the sending of the other notifications without the user knowing it)[cite: 49]
- [ ] Q1: User is notified if any user related security features are changed. (E.g. 2FA enabled/disabled, phone number changed, password changed)[cite: 49]
- [ ] Q1: Notify, limit or block the access if authentication is coming from suspicious (different from the normal) geo-location.[cite: 49]
- [ ] Q2: When user bank account details are changed user needs to be notified. (E.g. change of bank account number can lead to money to be sent to attackers bank account)[cite: 50]
- [ ] Q2: When large payments are done the user/accountant needs to be notified and asked to verify the payment. (E.g. threshold protects against fraudulent invoices)[cite: 50]
- [ ] Q2: Think of other high risk functionalities in your system and think of mitigations if a user account is compromised. E.g. Notify user, require re-authentication, set limits to limit or block the usage.[cite: 50]
- [ ] Q3: Validate the input and access rights always in the back end. (Presentation layer/ frontend validation is to make better UX. It is not considered as a security measure because checks in the presentation layer/ frontend are so easy to bypass)[cite: 50]
- [ ] Considered NoSql Injection attacks (Reference: OWASP NoSQL Injection testing)[cite: 51]
- [ ] AI-Q1: Use guardrails services to moderate the AI input and output but do not solely rely on them when securing the AI system.[cite: 51]
- [ ] AI-Q2: Output is validated and accepted output formats are limited together with strict CSP for allowed domains (AI is extremely good at providing the output in different formats which may include injected payload e.g. image url to attackers website with exfiltrated data in url parameters)[cite: 51]
- [ ] AI-Q3: Avoid open-ended, dangerous tools like direct shell access or raw database query execution. This has been a key factor in several real-world breaches.[cite: 51]
- [ ] AI-Q3: Use fine grained token based access control with minimum permissions necessary. Consider using the end user privileges when AI interacts with tools like RAG, agents or MCP. (Good starting point is to assume that everything AI can do or access, can be done and accessed by the end user interacting with the AI)[cite: 52]
- [ ] AI: Avoid ingesting data from unverified external sources (like scraped websites) directly into the system without sanitization[cite: 52]

---

## 6. Anti-patterns (Read and Acknowledge)
The agent must warn the user about these anti-patterns and verify they are avoided:

- [ ] Use of dynamic raw SQL statements generated on user input. (Instead, always use parameterized queries and sanitise the input data before being used. See OWASP SQL Injection protections)[cite: 53]
- [ ] AI-Q1: Relying solely on instructional defenses (guardrails) in the system prompt (e.g., "You are a helpful assistant. Do not...") without technical input/output filters.[cite: 53]
- [ ] AI-Q3: Granting an AI or agent a single, highly privileged service account to interact with backend systems.[cite: 53]

---

## 7. Execution Flow for VCDM Agent (Continued from Part 1)
5. **AI Tool Controls Q&A:** Guide the user through AI-Q3 to assess the controls placed on AI agents and tools, emphasizing least privilege[cite: 45].
6. **Extensive Checklist Review:** Methodically review the 27-item checklist. Ensure the user confirms that mitigations are selected[cite: 47], framework protections (ORM, XSS) are understood[cite: 47], and Jira tickets are created for unimplemented mitigations[cite: 48].
7. **Best Practices Confirmation:** Present the detailed best practices covering notifications[cite: 49, 50], backend validation[cite: 50], and strict AI guardrails (CSP, least privilege, sanitization)[cite: 51, 52].
8. **Anti-Pattern Warning:** Strongly warn against dynamic SQL[cite: 53] and the sole reliance on system prompts for AI security[cite: 53].
9. **Final Output generation.**


---

# Skill: SEC07 - Software Dependencies Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user in evaluating how they manage third-party software dependencies. It ensures they use Software Composition Analysis (SCA) tools, avoid embedded dependencies, regularly review for unused or outdated components, and apply specific supply chain security measures for AI/ML models.
**Goal:** Verify that all application components (frontend and backend) are identified and existing vulnerabilities are handled, mitigating risks from the software and AI supply chain.

---

## 1. Primary Directives for the Agent
- **Focus on SCA:** Emphasize the importance of using a Software Composition Analysis (SCA) service. If the user doesn't use one, or if it doesn't cover all code, they must provide a manual Bill of Materials (BOM) or create a ticket[cite: 55, 61].
- **Discourage Embedded Dependencies:** Actively discourage embedding third-party code directly into the source code; push for package managers[cite: 56, 62].
- **Process Over Detection:** Ensure the user doesn't just *detect* vulnerabilities, but has a structured *process* to identify, fix, and update out-of-date and end-of-life components[cite: 59, 60, 62].
- **AI Context:** Remind the user that ML extends vulnerability risks to pre-trained models and training data susceptible to tampering[cite: 54].

---

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions sequentially.

### **Q1: Can you detect and list all components in your project? Such as with Software Composition Analysis Service (SCA), and/or in package.json or similar**
**Options:**
- Yes, all application source code is scanned by the SCA service and the full BOM is available in that service[cite: 55]
- Yes, but the SCA service does not scan ALL/ANY of our source code. Provide a link to your Bill of Materials (BoM) for the 3rd party components of the source code that is NOT scanned by the SCA service:[cite: 55]
- No (create ticket)[cite: 55]

### **Q2: Do you have external third party components embedded into your application source code that could benefit from being included through a package manager?**
**Options:**
- No[cite: 56]
- Yes (consider ticket)[cite: 56]

### **Q3: Are all components necessary? Do a review. Legacy components may pose a unnecessary risk.**
**Options:**
- Yes, review done[cite: 57]
- No, review done and unnecessary components identified (ticket required)[cite: 57]

### **Q4: If developing LLM/ML functionality in your application, are the external third party components used by the data science team and the ML pipeline, regularly scanned by the current SCA service?**
**Options:**
- N/A[cite: 58]
- Yes[cite: 58]
- No (create ticket)[cite: 58]

### **Q5: Do you have a process in place to identify and fix components with known vulnerabilities?**
*Agent Context: Software Composition Analysis Service helps you detect and identify, but not fix. If you periodically update components in a structured manner, you have a process.*
**Options:**
- Yes (detect and identify only)[cite: 59]
- Yes (detect, identify and fix)[cite: 59]
- No (create ticket)[cite: 59]

### **Q6: Do you have a process to update out-of-date components and replacing end-of-life components?**
*Agent Context: SCA does not help you with this. Manual periodical review required or package.json+IDE plugins can help you with this.*
**Options:**
- Yes, both out-of-date and end-of-life[cite: 60]
- No (create ticket)[cite: 60]
- Only for out-of-date (create ticket for end-of-life)[cite: 60]
- Only for end-of-life (create ticket for out-of-date)[cite: 60]

---

## 3. Mandatory Self-Review Checklist
The agent must confirm all of the following checkboxes are verified by the user:

- [ ] Q1: A link to the list/or the actual BOM of components NOT scanned by the SCA service is added. (For the code that is not scanned/unsupported by the SCA service the list of third party components needs to be provided by the team)[cite: 61].
- [ ] Q3: A review needs to be done to identify possible unused components. If unused components are found, improvement tickets to remove them should be created and linked to the assessment. (Not used components possess unnecessary risk for vulnerabilities)[cite: 61].
- [ ] You have verified and updated any open improvement items from previous year[cite: 61].

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] The accuracy of the list of components provided by the SCA service depends on how good coverage the service has on your source code base[cite: 61].
- [ ] Have a process to regularly update the components[cite: 62].
- [ ] Have a process to quickly react and fix critical issues found in the third party components[cite: 62].
- [ ] AI-Q1: Maintain an AI-BOM using standards like SPDX 3.0 or CycloneDX to track all models, data, and library dependencies. (Reference: OWASP AI Security Overview)[cite: 62].

---

## 5. Anti-patterns (Read and Acknowledge)
The agent must warn the user about these anti-patterns and verify they are avoided:

- [ ] Use of source code or binary embedded dependencies. (Keeping the embedded dependency code or binary up to date and fixing any conflicts, that appear when doing manual changes to its source code, is very hard to do. Strive to use a proper package management system for external dependencies)[cite: 62].
- [ ] AI: Blindly trusting and downloading models or agentic tools from public repositories without performing security validation first[cite: 63].

---

## 6. Execution Flow for VCDM Agent
1. **Initialize:** Introduce SEC07 and explain the risks of third-party vulnerabilities, including ML supply chain risks[cite: 54].
2. **Q&A Execution:** Ask questions Q1 through Q6 sequentially. Ensure the user selects from the exact options provided.
3. **Ticket Enforcement:** If the user selects answers requiring a ticket (e.g., No SCA coverage, embedded dependencies, lack of update process), pause and ensure they acknowledge the need to create one[cite: 55, 56, 59, 60].
4. **Self-Review Checklist Verification:** Review the 3 checklist items, specifically ensuring manual BOMs are linked if needed[cite: 61].
5. **Acknowledge Best Practices & Anti-patterns:** Present the best practices (processes and AI-BOM)[cite: 61, 62] and strongly warn against embedded dependencies and blindly trusting public AI models[cite: 62, 63].
6. **Final Output:** Generate a summary report for SEC07 detailing dependency management processes and noting any gaps requiring improvement tickets.


---

# Skill: SEC08 - File Upload Validation Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user in evaluating how their application handles file uploads. It ensures that uploaded files are properly validated, stored securely without execute permissions, and that user-provided file names are not used directly to prevent traversal attacks.
**Goal:** Protect the product from the impact of malicious files and protect users from any negative impact caused by those files.

---

## 1. Primary Directives for the Agent
- **Conditional Flow:** Question 2, 3, and 4 should only be strictly enforced if the user answers "Yes" to Question 1 (the application supports file uploads).
- **Enforce Secure Naming:** If the user admits that the physical file name or folder is controlled by the user (Q3), mandate the creation of a ticket to generate GUIDs instead[cite: 67].
- **Validation Layers:** Ensure the user understands that file validation requires multiple layers (content checking, type, extension lists, size, and antivirus scanning)[cite: 68, 69, 70, 71].

---

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions based on the initial response.

### **Q1: Does the application support file upload by the user?**
**Options:**
- Yes[cite: 65]
- No[cite: 65]

*(Agent Note: If the answer is 'No', the agent can skip to the Self-Review Checklist, as the following questions depend on a 'Yes' answer).*

### **Q2: If yes, is the content read/parsed/mapped in any way? Click all that applies.**
**Options:**
- Yes, by the service[cite: 66]
- Yes, by another Visma service, e.g. as basis for payroll data or similar between systems[cite: 66]
- Yes, by another non-Visma service[cite: 66]
- No, file is only stored as a static file with execute permission[cite: 66]
- No, file is only stored as a static file with read permission[cite: 66]
- N/A[cite: 66]

### **Q3: If yes on first question, is physical file name or folder controlled by the user?**
*Agent Context: Consider generating GUIDs instead of users supplied naming.*
**Options:**
- No[cite: 67]
- Yes (create ticket)[cite: 67]
- N/A[cite: 67]

### **Q4: If yes on first question, how is the file content validated to be safe? Select all implemented.**
*Agent Context: If you are scanning the file or doing file content checking together with other validations you are not required to create a follow-up action.*
**Options (Select all that apply):**
- Scanned for virus with anti-virus[cite: 68]
- File Content checking (e.g. try to parse it with a library and see if it fails, even if no processing is intended)[cite: 68, 69]
- File Content Type (e.g. header or magic bytes)[cite: 68, 69]
- File extension allow list[cite: 68, 69]
- File extension deny list[cite: 68, 69]
- File size[cite: 68, 69]
- No validation[cite: 69]
- N/A[cite: 69]

---

## 3. Mandatory Self-Review Checklist
The agent must confirm all of the following checkboxes are verified by the user:

- [ ] Q1: Files uploaded by end user through other systems that are then stored in your system should be validated as well[cite: 70].
- [ ] You have verified and updated any open improvement items from the previous assessment (if any)[cite: 70].
- [ ] If you rely on other systems for doing the file validation you have confirmed that they are actually doing the validations you expect[cite: 70].

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] Do the file type signature verification (Reference: Microsoft threat modeling file upload recommendations)[cite: 70].
- [ ] If the cloud hosting platform supports any type of file verification it should be utilised (References: Microsoft Defender for Storage, Cloud Storage Security - AWS Partnership, ClamAV with GCP)[cite: 70].
- [ ] Scanning the files with antivirus should be done when possible (E.g. self-hosted solutions like ClamAV, SaaS offerings like Cloudmersive, on-premise solutions like Microsoft Defender Antivirus)[cite: 71].

---

## 5. Anti-patterns (Read and Acknowledge)
The agent must warn the user about these anti-patterns and verify they are avoided:

- [ ] Storing uploaded files with execute permissions can lead to remote code execution in the storage machine. (Instead store the uploaded files only with least privileges - read permission)[cite: 71].
- [ ] When storing the physical file or folder name controlled by the end-user the name provided by the end-user should not be used. (Instead use names generated by the application. For example GUIDs)[cite: 71].
- [ ] Using the file name provided by an end-user can lead to directory traversal attacks[cite: 72].

---

## 6. Execution Flow for VCDM Agent
1. **Initialize:** Introduce SEC08 and state the goal of protecting the system from malicious file uploads[cite: 64]. Provide the link to the OWASP File Upload Cheat Sheet[cite: 64].
2. **Q&A Execution (Conditional):** Ask Q1[cite: 65]. If 'Yes', proceed to ask Q2, Q3, and Q4, ensuring the user selects from the exact options provided[cite: 66, 67, 68, 69].
3. **Ticket Enforcement:** If the user selects "Yes (create ticket)" in Q3, or if they indicate storing files with execute permission in Q2, pause and ensure they acknowledge the need to create a ticket to rectify these critical issues[cite: 66, 67].
4. **Self-Review Checklist Verification:** Review the 3 checklist items, emphasizing that files from other systems must also be validated[cite: 70].
5. **Acknowledge Best Practices & Anti-patterns:** Present the best practices regarding signature verification and cloud/antivirus scanning[cite: 70, 71]. Strongly warn against the anti-patterns of storing files with execute permissions and using user-provided file names directly[cite: 71, 72].
6. **Final Output:** Generate a summary report for SEC08 detailing the file upload mechanisms and validations, noting any gaps requiring improvement tickets.


---

# Skill: SEC09 - Secrets in Source Code Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user to verify that no sensitive secrets are hardcoded or stored within the source code across all environments. It enforces the use of secure secret management systems and rotation of any previously compromised secrets.
**Goal:** Ensure the source code repository is completely free of hardcoded secrets, as source code is easily duplicated and should never be considered a secure storage location.

---

## 1. Primary Directives for the Agent
- **Zero Tolerance Policy:** Clearly state that storing secrets in source code is like "playing with fire"[cite: 73]. If a secret is found, it must be removed, moved to a secure location, and immediately rotated[cite: 75].
- **Define "Secrets":** Provide the user with clear examples of what constitutes a secret before they answer the question[cite: 74].
- **Mandatory Review:** The user cannot simply guess; they must perform a manual or automated review of critical sections before answering[cite: 75].

---

## 2. Assessment Questions (Q&A Flow)

### **Q1: Verify by reviewing critical sections of the source code that you do not store secrets in source code.**
*Agent Context: This applies to all environments including test environments[cite: 74]. Source code should not be considered secret. Secrets previously stored in source code should be rotated[cite: 74].*

**Provide these examples to the user before they answer[cite: 74]:**
- Passwords (integration, database credentials etc.)
- Encryption keys
- Certificate private keys
- SSH keys
- AWS keys
- OAuth tokens
- JSON web tokens

**Options:**
- No, no secrets are stored in the source code[cite: 74]
- Yes, review done and secrets in source code have been identified (ticket required)[cite: 74]

---

## 3. Mandatory Self-Review Checklist
The agent must confirm all of the following checkboxes are verified by the user:

- [ ] Make a source code review (manual or via appropriate tools) to identify if you have secrets in source code before answering the question. (It is not an excuse not to do it if you do not have a tool)[cite: 75].
- [ ] Create tickets for the identified secrets found in source code. (The tickets should require moving the secret from source code to a secure location and the rotation of the secret)[cite: 75].
- [ ] You have verified and updated any open improvement items from previous year[cite: 75].

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] All the secrets should be generated/saved to the production environment during the installation or deployment process[cite: 75].
- [ ] Do not store secrets (like database passwords, encryption keys) in the source code repository. (Any secret stored in the source code repository is copied to the developers' machines as well; making that secret less secure)[cite: 76].
- [ ] For on-premise applications use secret management tooling or a customer specific encrypted configuration file to store the secrets at runtime. (All secrets should be customer specific. Do not store secrets in application binary files and share them to all customers)[cite: 76].
- [ ] Use a secret management system to store secrets (e.g. Hashicorp Vault or a secret manager service provided by the cloud provider)[cite: 76].

---

## 5. Anti-patterns (Read and Acknowledge)
The agent must warn the user about this critical anti-pattern and verify it is strictly avoided:

- [ ] Do not rely on obfuscation for hiding the secrets in the source code. Obfuscation is not considered as a security measure. (Attackers can use de-obfuscation techniques to undo the obfuscation)[cite: 77].

---

## 6. Execution Flow for VCDM Agent
1. **Initialize:** Warn the user that storing secrets in code is highly dangerous because Git repositories duplicate the entire history when cloned[cite: 73].
2. **Define Scope:** List the examples of secrets (passwords, AWS keys, tokens, etc.)[cite: 74] and insist that the user must review their code (manually or via tools) before answering[cite: 75].
3. **Q&A Execution:** Ask Q1[cite: 74].
4. **Ticket Enforcement:** If the user answers "Yes, review done and secrets... have been identified", immediately instruct them to create a ticket. Explicitly state that the ticket MUST include moving the secret AND rotating the compromised secret[cite: 74, 75].
5. **Self-Review & Best Practices:** Walk through the checklist[cite: 75] and emphasize the use of proper secret management tools (like Hashicorp Vault) over storing anything in the repo[cite: 76].
6. **Anti-pattern Warning:** Clarify that obfuscation is useless as a security measure for secrets[cite: 77].
7. **Final Output:** Generate a summary report for SEC09, highlighting either a clean repository or the urgent tickets created for secret rotation.


---

# Skill: SEC10 - Secret Management Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user to document and validate all secrets their product relies on in production. The agent ensures that secrets are listed, their locations identified, their confidentiality assured, and that change procedures exist.
**Goal:** Ensure comprehensive secret management, limiting access, utilizing encrypted storage or secret management tools, and establishing clear procedures for emergency secret rotation.

---

## 1. Primary Directives for the Agent
- **Focus on Production:** Clarify that this section only applies to secrets tied to service accounts etc., required for the product to function when deployed in production[cite: 78].
- **Table Data Collection:** The core of this section requires the user to document their secrets in a specific table format. You must prompt them for this structured data.
- **Enforce Best Practices:** Strongly advocate for managed identities/IAM roles over storing secrets, and ensure they use dedicated secret management tools (like Azure Key Vault or AWS Secrets Manager)[cite: 82, 83].

---

## 2. General Requirements (To be validated)
The agent must ensure the user documents what secrets their product relies on to function when deployed in production[cite: 78]. 

**Examples of secrets to provide to the user[cite: 78]:**
- Database credentials for web application to access database
- API keys to access external APIs
- TLS private key
- Encryption keys
- Service account passwords
- Integration passwords

The agent must prompt the user to provide the following information for *each* secret in a table format[cite: 79, 80]:
1. **Purpose:** What is the secret used for?
2. **Location(s):** Where is the secret stored in any phase of the lifecycle?
3. **Confidentiality:** How is the secret protected (e.g., Secret Management tool with restricted access)?
4. **Strong secret:** Is the secret cryptographically strong?
5. **Change procedure:** Link to documentation or a short description of how the secret is changed/rotated.

---

## 3. Mandatory Self-Review Checklist
The agent must confirm all of the following checkboxes are verified by the user:

- [ ] All secrets used or needed by the application are listed. (See documentation for examples)[cite: 81].
- [ ] All locations where a secret is stored (in any phase of the application life-cycle) are listed for each secret[cite: 81].
- [ ] Each secret have description how their confidentiality is assured. (How the secret is protected e.g. Secret Management tool with restricted access)[cite: 81].
- [ ] All secrets have either link to change procedure documentation or short description how the change procedure is handled[cite: 81].
- [ ] You have verified and updated any open improvement items from previous year[cite: 81].

---

## 4. Best Practices and Recommendations (Read and Acknowledge)
The agent must remind the user of these best practices and ensure they are read and acknowledged:

- [ ] Limit the access to the secret only to the services/users who really need it[cite: 82].
- [ ] Secrets (e.g. encryption keys) should be unique for each customer/installation. Do not use shared keys[cite: 82].
- [ ] Secret storage needs to be encrypted[cite: 82].
- [ ] Use strong secrets[cite: 82].
- [ ] When possible use secret management tools e.g. Azure Key Vault, AWS Secrets Manager[cite: 82].
- [ ] For cloud hosted services use managed identities, IAM roles whenever possible. (You will not need to store and rotate secrets)[cite: 83].
- [ ] Minimum secret change procedure is that you have the technical capability to change the secret and you know how to change it (documented procedure) in case of emergency[cite: 83].
- [ ] Read about best practices and guidelines for properly implementing secrets management. (Reference: OWASP Secrets Management Cheat Sheet)[cite: 83].

---

## 5. Execution Flow for VCDM Agent
1. **Initialize:** Introduce SEC10 and list the examples of production secrets (database credentials, API keys, etc.)[cite: 78].
2. **Data Collection (Table):** Prompt the user to provide their secrets inventory according to the 5 required columns (Purpose, Location(s), Confidentiality, Strong secret, Change procedure)[cite: 79, 80].
3. **Checklist Verification:** Run through the 5 checklist items, ensuring that the user has explicitly documented how confidentiality is assured and how change procedures are handled for *every* secret[cite: 81].
4. **Acknowledge Best Practices:** Present the best practices, emphasizing the preference for managed identities/IAM roles[cite: 83] and the absolute necessity of having an emergency change procedure[cite: 83].
5. **Final Output:** Generate a summary report for SEC10, detailing the inventoried secrets and confirming that secret management tools and rotation procedures are in place.

# SSA Validator - Sections SEC11 through SEC16

This companion file contains the remaining sections of the Security
Self-Assessment (SSA) Validator skill for the VCDM agent.
It is loaded together with SKILL.md, which contains SEC01 through SEC10.

---

# Skill: SEC11 - Phishing Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user in evaluating how their application
manages outgoing communications (emails, SMS, notifications). It ensures that
messages do not contain unnecessary links, confidential information, or risky
attachments, and that dynamic content is rigorously validated to prevent the
platform from being used for phishing campaigns.
**Goal:** Reduce the phishing attack surface by limiting direct links,
protecting personal data in communications, and validating any user input used
in message generation.

---

## 1. Primary Directives for the Agent

- **Phishing Awareness:** Remind the user that phishing aims to steal identities
  by making people reveal personal information on fake sites.
- **Input Validation:** If email content depends on user input, emphasize that
  it MUST be validated or sanitized.
  Agent Example: "Hello, click here <link with GUID> to approve" is safe. But
  "Hello {user}, click here..." requires validation of the {user} variable.
- **Link Policy:** Strongly recommend that links not be included directly in
  messages; it is preferable to guide the user to log in to the platform they
  already know.
- **Conditional Flow:** If the application does not send messages (Answer "No"
  in Q1), the agent can skip Q2 to Q5.

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions based on the initial response.

### Q1: Does the application generate messages or notifications that are distributed by email, SMS, or another form of messaging?
Options:
- Yes
- No

(Agent Note: If the answer is "No", proceed directly to the Checklist, as the
remaining questions do not apply.)

### Q2: If yes, does it contain any links?
Agent Context: If the user expects a message to approve something, they probably
already know where to log in. It is recommended not to provide direct links.
Options:
- Yes, clickable, other type of links, please describe (consider ticket)
- Yes, clickable, only for password reset
- Yes, non-clickable (consider ticket)
- No
- N/A

### Q3: Does it contain any personal data or sensitive information?
Options:
- Yes, review done and only necessary information is distributed
- Yes, review done and improvements found (create ticket)
- No
- N/A

### Q4: Does it contain any attachments?
Agent Context: Ensure that personal or sensitive data is not sent as an
attachment.
Options:
- No
- Yes (consider ticket)
- N/A

### Q5: Is the content based on user input?
Agent Context: E.g. control of the subject field or message content in whole or
in part to make the message fraudulent.
Options:
- Yes, review done and email content is carefully validated before being sent
- Yes, review done and validation improvements found (create ticket)
- No
- N/A

## 3. Mandatory Self-Review Checklist

- [ ] Q2: If the "clickable, other types of links" option is selected, a
      description about the types of messages that contain links is added.
- [ ] Q2: You have analyzed the possibility of removing links from your
      messages. Improvement tickets are created and linked to the assessment if
      necessary.
- [ ] Q3: You have analyzed whether you can remove personal or sensitive
      information from the messages. Improvement tickets are created and linked
      to the assessment if necessary.
- [ ] Q4: You have analyzed whether you can remove attachments from the
      messages. Improvement tickets are created and linked to the assessment if
      necessary.
- [ ] Q5: You have analyzed that user input is carefully validated and, if not,
      improvement tickets are created and linked to the assessment.
- [ ] You have verified and updated any open improvement items from the previous
      year.

## 4. Best Practices and Recommendations (Read and Acknowledge)

- [ ] Limit the number of clickable links sent in messages to customers. These
      can be replaced with information that will guide the user to find the
      necessary data in the application. (Introduce links only where truly
      necessary, e.g. forgot password functionality.)
- [ ] Q4: It is better to create a view in the application to display attachment
      details than to send the attachment in the email.
- [ ] Q4: Consider password-protecting attachments in the email if you really
      need to send them.
- [ ] Restrict sending emails from demo accounts; these are shared accounts and
      login details are usually known by a wide audience. (You do not want your
      system to be used to send phishing emails.)
- [ ] Limit the maximum number of recipients allowed when sending an email. (By
      limiting the number of recipients, you make it harder to send phishing
      emails to a wide audience with a single click.)
- [ ] Implementing rate limiting on the messaging feature can help minimize the
      number of fraudulent messages delivered to customers in case the
      application is exploited for phishing purposes.
- [ ] Q5: Avoid allowing messages to be personalized based on end-user input.
      Validate carefully otherwise. (Sanitize any link that the user tries to
      enter in the message. Sanitize dynamic message parts - templates, keywords
      - that a user can change and retrieve other data from your database.)

## 5. Execution Flow for VCDM Agent

1. **Initialize:** Present SEC11, explaining how attackers abuse legitimate
   messaging systems and the importance of validating variables (like {user}).
2. **Conditional Q&A Execution:** Ask Q1. If the answer is "Yes", continue with
   Q2 to Q5, presenting the exact options for consistency with the underlying
   system.
3. **Ticket Enforcement:** If the user selects answers that include "(consider
   ticket)" (e.g., clickable links or attachments) or "(create ticket)" (e.g.,
   validation improvements), the agent must request justification or ensure the
   ticket is created in the management system.
4. **Checklist Verification:** Go through the 6 checklist items, ensuring that
   the thorough analysis of removing links, sensitive data, and attachments was
   actually carried out.
5. **Best Practices Acknowledgment:** Emphasize reducing links, avoiding bulk
   sends from demo accounts, setting recipient limits (rate limiting), and the
   sanitization of any dynamic input.
6. **Final Output:** Generate a summary report of the application posture against
   phishing abuse and document the actions to be taken.

---

# Skill: SEC12 - Testing and Quality Assurance (QA) Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill evaluates the integration of security into the
team testing and quality processes. It verifies whether developers and the QA
team actively look for security issues, whether they are trained to do so, and
evaluates the robustness of post-launch monitoring.
**Goal:** Ensure that unit and QA tests not only validate functionality, but
also basic security controls, and guarantee that adequate monitoring and
ongoing security training exist.

---

## 1. Primary Directives for the Agent

- **Security Unit Testing:** Emphasize that unit tests must confirm that basic
  security controls work (e.g., failures without CSRF tokens, authentication
  requirements, HTML filters).
- **Training:** Validate whether the team has the necessary training (e.g., use
  of scanners or tools like Burp) and encourage the use of learning platforms.
- **Realistic Monitoring:** Require an honest assessment of post-launch
  monitoring. If it is weak or non-existent, the creation of a ticket is
  mandatory.

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions sequentially.

### Q1: Do developers and/or QA look for potential security issues during testing?
Options:
- Yes
- No (consider ticket)

### Q2: Have they been trained to do so?
Agent Context: This could be, for example, the use of Burp or a security
scanner.
Options:
- Yes
- No

### Q3: How would you describe your post-launch monitoring?
Option descriptions for the user:
- Robust: We have procedures to log and monitor unexpected failures, exceptions,
  and other error conditions. If something looks suspicious, a
  security-knowledgeable engineer evaluates it.
- Weak: If something goes wrong, like a spike in failure rates, we will probably
  notice. But our monitoring is fairly superficial and there is room for
  improvement.
- Nonexistent: At the moment, we are not performing any type of post-launch
  monitoring that looks for signs of exploitation or increases in
  failures/exceptions.

Options:
- Robust
- Weak (consider ticket)
- Nonexistent (ticket highly recommended)
- N/A (add justification as comment below)
- N/A, customer installed

## 3. Mandatory Self-Review Checklist

- [ ] Q3: Assess how reliable your post-launch monitoring is and create
      improvement tickets for missing monitoring.
- [ ] You have verified and updated any open improvement items from the previous
      year.

## 4. Best Practices and Recommendations (Read and Acknowledge)

- [ ] If you have a mobile application, increase mobile security testing skills
      within the team. (See the OWASP Mobile Application Security project.)
- [ ] Security is a shared responsibility. Everyone on the project team must be
      accountable for security.
- [ ] Ensure developers maintain secure coding knowledge through training or
      hands-on practice. (Use platforms like O'Reilly, Udemy, OWASP Top 10,
      OWASP Juice Shop. Record what the team has completed.)
- [ ] AI: Test AI for AI-specific attacks. The VSP Offensive AI Playbook
      provides a robust set of verified attack methods and guides on how to test
      the system against them.

## 5. Execution Flow for VCDM Agent

1. **Initialize:** Present SEC12, explaining that unit tests must also cover
   security controls (e.g., CSRF, input filters).
2. **Q&A Execution:** Ask questions Q1, Q2, and Q3.
3. **Ticket Enforcement:** If the user selects that they do not look for
   security issues (Q1) or that their monitoring is weak/non-existent (Q3), the
   agent must require the creation of improvement tickets and their linking to
   the assessment.
4. **Checklist Verification:** Go through the 2 checklist items, ensuring that
   the reliability of monitoring is honestly evaluated.
5. **Best Practices Acknowledgment:** Emphasize shared responsibility, the need
   for ongoing training, specific testing if there is a mobile app, and the use
   of offensive playbooks if Artificial Intelligence is implemented.
6. **Final Output:** Generate the SEC12 section report.

---

# Skill: SEC13 - Secure Deployment Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user in evaluating the security of their
deployment toolchain. It verifies the type of services used for source code
management, CI (Continuous Integration), and CD (Continuous Deployment), with
special attention to the maintenance and updating of self-managed services.
**Goal:** Ensure that all tools involved in the product deployment process are
secure, mitigating the risks of a compromised software supply chain.

---

## 1. Primary Directives for the Agent

- **Identify Self-Managed Services:** The agent must pay close attention if the
  user selects "self managed services" in any question. This increases the user
  responsibility regarding updates and patching.
- **Critical Maintenance:** If they use self-managed services (e.g., Jenkins,
  ArgoCD), it is mandatory to confirm that the software is kept up to date with
  the latest patches on a regular basis.
- **Access Review:** Emphasize that only strictly necessary personnel should
  have access to CI/CD tools and code repositories.

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions sequentially.

### Q1: Source Code Management System
Options:
- Yes, by using managed services (GitHub or similar)
- Yes, by using self managed services
- No/unsure (create ticket)

### Q2: Build/CI Systems
Options:
- Yes, by using managed services (teamcity.visma.com or similar)
- Yes, by using self managed services (eg. Jenkins)
- No/unsure (create ticket)

### Q3: CD/Orchestration/Deployment Systems
Options:
- Yes, by using managed services (octopus.visma.com or similar)
- Yes, by using self managed services (eg. Jenkins, ArgoCD)
- Yes, by using self managed custom application/script, please describe
  (consider ticket)
- No/unsure (create ticket)
- N/A (no service)

### Q4: If self-managed services are used (SCM, CI, CD), the software is kept up to date with the latest versions and patches are applied regularly.
Agent Note: Only ask if the user selected a self-managed service in Q1, Q2 or
Q3.
Options:
- Yes
- No/unsure (create ticket)
- N/A

## 3. Mandatory Self-Review Checklist

- [ ] If you do not know that your self-managed services are regularly updated
      and correctly configured, an improvement ticket is created.
- [ ] You have performed an access review of your team members across all CI/CD
      tools used and only the necessary people have access; source code
      repository, continuous integration service, continuous deployment server.
- [ ] You have verified and updated any open improvement items from the previous
      year.

## 4. Best Practices and Recommendations (Read and Acknowledge)

- [ ] Self-managed services are correctly configured (hardened).
- [ ] All self-managed services that are part of your CI/CD pipeline are
      regularly updated; updates are installed as soon as they are available.
- [ ] The infrastructure (VMs) of self-managed services is correctly configured
      and periodically maintained.

## 5. Anti-patterns (Read and Acknowledge)

- [ ] Deploying the application to Test/Production environments from the
      developer machine. (Instead, use a deployment automation tool.)

## 6. Execution Flow for VCDM Agent

1. **Initialize:** Present SEC13, asking how the tools in the deployment process
   are secured.
2. **Q&A Execution (Q1-Q3):** Evaluate the type of services (managed vs.
   self-managed) for SCM, CI, and CD.
3. **Conditional Validation (Q4):** If any self-managed service was detected,
   ask Q4 to verify constant patching. If the answer is "No/unsure", force the
   creation of a ticket.
4. **Checklist Verification:** Go through the 3 checklist items, with special
   emphasis on the team access review to these critical tools.
5. **Best Practices & Anti-patterns Acknowledgment:** Present the best practices
   on hardening and maintenance of self-managed infrastructure. Issue a strong
   warning against manual deployments from developers local machines.
6. **Final Output:** Generate the SEC13 section report, detailing the deployment
   chain posture.

---

# Skill: SEC14 - Infrastructure Permissions Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user in auditing the permissions granted
to infrastructure (databases, storage, queues, service buses). The focus is on
non-human identities (service accounts) to ensure that the Principle of Least
Privilege is applied and that resources are not unnecessarily exposed.
**Goal:** Ensure that each infrastructure component has only the strictly
necessary permissions to function, separating roles (e.g., migrations vs. CRUD
operations) and preventing accidental public exposure.

---

## 1. Primary Directives for the Agent

- **Focus on Service Accounts:** Clarify that this review focuses on service
  accounts and other non-human user permissions.
- **Principle of Least Privilege (PoLP):** Constantly reiterate this principle.
  For example, the database user often only needs full access (ALTER, DROP) when
  updating the schema, not during normal use (CRUD). Splitting into different
  accounts is mandatory.
- **Structured Data Collection:** The user must provide a table detailing each
  infrastructure identity in order to assess whether PoLP is met.

## 2. General Requirements (To be validated)

The agent must ask the user to list the infrastructure identities (or
equivalents), review their permissions, and look for areas of improvement.

The user must provide the following information in table format for each
identity:
1. Account/Role/Access policy: Name of the account or role.
2. Least Principle: Does it comply with the principle of least privilege?
   (Yes/No, and why.)
3. Purpose: What is this account/role used for?
4. Used by?: Which component or service uses this account?

## 3. Mandatory Self-Review Checklist

- [ ] Check your diagram and list all the infrastructure users / accounts used
      by the application. (Use naming conventions that will help you identify
      these accounts later.)
- [ ] Do you allow external systems to consume data directly from your database?
      Check the rights the database user has and create improvement action to
      remove unneeded rights.
- [ ] You have considered creating improvement actions for the accounts that
      do not follow least privilege principle.
- [ ] You have verified and updated any open improvement items from previous
      year.

## 4. Best Practices and Recommendations (Read and Acknowledge)

- [ ] Limit the access of the users only to the services and operations they
      really need to do.
- [ ] Have separate user for the database upgrade/migration activities (ALTER,
      DROP rights) than the regular runtime application user (CRUD rights, NO
      ALTER or DROP rights).
- [ ] Use platform managed identities / IAM roles and provide granular role
      based access controls.
- [ ] Give the cloud resources the minimum access rights they need. Do not use a
      high privilege account which can do everything in your subscription.
- [ ] Enable JIT (just-in-time) access for your cloud environments. (Visma
      Privileged User Management portal can be used to facilitate this.)
- [ ] Use dedicated Visma domain accounts, with MFA enabled, for accessing your
      cloud environments. (Visma accounts are automatically disabled when an
      employee leaves. One factor authentication is more vulnerable to brute
      force attacks.)

## 5. Anti-patterns (Read and Acknowledge)

- [ ] Azure Storage Account access keys are not following least privilege
      principle. (They provide access to both service management and data
      planes. Instead use managed identities with RBAC.)
- [ ] Azure Storage Account SAS tokens are hard to manage and revoke. (For
      external sharing, consider using a Service SAS with a Stored Access Policy
      to manage policies and revoke them in a centralised manner.)
- [ ] Allowing external systems to consume data directly from your database.
      (Instead expose the data through an api endpoint or search engine.)

## 6. Execution Flow for VCDM Agent

1. **Initialize:** Present SEC14, clearly defining the Principle of Least
   Privilege (PoLP) applied to non-human infrastructure accounts.
2. **Data Collection (Table):** Ask the user for the table with the columns:
   Account/Role/Access policy, Least Principle, Purpose, and Used by?
3. **Analysis and Tickets:** Review the submitted table. If any account has
   excessive permissions (e.g., the same account for migrations and CRUD
   operations), the agent must require the creation of an improvement ticket.
4. **Checklist Verification:** Go through the 4 checklist items, ensuring that
   the system diagram (SEC01) was consulted to avoid omitting accounts.
5. **Best Practices & Anti-patterns Acknowledgment:** Present the best practices
   (JIT, dedicated accounts with MFA, separation of DB roles) and the
   anti-patterns (direct DB access, misuse of Azure Storage keys).
6. **Final Output:** Generate the SEC14 section report, summarizing the reviewed
   permissions and the remediation actions (tickets) generated.

---

# Skill: SEC15 - Network and Host Security Basics Assessment
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user in evaluating the management of the
underlying infrastructure. It verifies who is responsible for OS patching, host
hardening, network (firewall) configuration, and DNS protection.
**Goal:** Ensure that infrastructure maintenance responsibilities are clearly
defined, prioritizing automation (Infrastructure as Code - IaC) over manual
processes, and guaranteeing protection against network attacks such as DDoS.

---

## 1. Primary Directives for the Agent

- **Prioritize IaC:** The agent must strongly favor responses that indicate the
  team manages infrastructure through version-controlled code or scripts (IaC).
- **Penalize Manual Processes:** If the user selects that the team performs tasks
  manually (especially if documentation does not exist or is not updated), the
  agent must require the creation of an improvement ticket.
- **Clear Responsibility:** Ensure the user knows exactly who has responsibility
  (the team, an external vendor, or the customer). If "Not done at all", force
  the creation of a ticket.

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions sequentially.

### Q1: Host patch management - Application of OS patches and updates.
Options:
- By the team
- By other Visma entity (e.g. Employee Tools, VITC)
- By external vendor (e.g. cloud hosting provider such as Azure, AWS, Google)
- By customer
- Not done at all (create ticket)
- Other, please specify...
- N/A (only PaaS and/or SaaS is used)

### Q2: Host hardening/configuration - Security settings and removal of unnecessary software.
Options:
- By the team via source controlled infrastructure as code or scripts
- Manually by the team, documentation exists and is updated
- By other Visma entity (e.g. Employee Tools, VITC)
- By external vendor (e.g. cloud hosting provider such as Azure, AWS, Google)
- By customer
- Not done at all (create ticket)
- Other, please specify...
- N/A (only PaaS and/or SaaS is used)
- Manually by the team, documentation does not exist or is not updated
  (create ticket)

### Q3: Network security management - Ports, Firewalls, etc.
Options:
- By the team via source controlled infrastructure as code or scripts
- Manually by the team, documentation exists and is updated
- By other Visma entity (e.g. Employee Tools, VITC)
- By external vendor (e.g. cloud hosting provider such as Azure, AWS, Google)
- By customer
- Not done at all (create ticket)
- Other, please specify...
- Manually by the team, documentation does not exist or is not updated
  (create ticket)

### Q4: DNS security management. Does your DNS provider support protection against DNS DDoS attacks?
Agent Context: If you are unsure, research before answering this question.
Options:
- Yes, the DNS provider does support protection against DNS DDoS attacks and we
  have implemented this solution.
- Yes, the DNS provider does support protection against DNS DDoS attacks, but we
  have not implemented the solution (create ticket to implement it)
- No, the DNS provider does not support protection against DNS DDoS attacks
  (create ticket to change the DNS provider)
- N/A, only for customer installed

## 3. Mandatory Self-Review Checklist

- [ ] It is known who is responsible for maintaining and configuring the
      infrastructure and the network. If not, an improvement ticket is
      considered.
- [ ] In shared network responsibility models, it is important to have clarity
      and document the specific actions taken during system patching or
      configuration. If not, an improvement ticket is considered.
- [ ] Documentation exists for procedures related to host patching and
      configuration, as well as network and firewall configurations, when
      carried out by the team. If not, an improvement ticket is considered.
- [ ] You have knowledge about your DNS provider and whether they provide
      protection against DDoS attacks targeting DNS infrastructure.
- [ ] You have verified and updated any open improvement items from the previous
      year.

## 4. Best Practices and Recommendations (Read and Acknowledge)

- [ ] Use Infrastructure as Code (IaC) to build your environment. Not tracking
      changes in systems could cause configuration errors. (Also, it could lead
      to unauthorized changes.)
- [ ] Scan IaC templates. (Infrastructure components can have vulnerabilities
      just like software dependencies.)
- [ ] Use cloud managed services whenever possible. (E.g., maintaining your own
      SFTP server involves maintenance and costs. Consider cloud platform
      alternatives like SFTP support for Azure Blob Storage or AWS Transfer
      Family.)

## 5. Anti-patterns (Read and Acknowledge)

- [ ] The use of default configurations for a cluster environment creates
      potential risks. (Instead, harden the environments according to their
      specific best practices. See CIS Benchmarks.)

## 6. Execution Flow for VCDM Agent

1. **Initialize:** Present SEC15, explaining the importance of having clear
   owners for patching and network/host configuration.
2. **Q&A Execution (Q1-Q4):** Iterate through the 4 questions.
3. **Ticket Control:** If the user selects manual configurations without
   documentation (Q2, Q3), that the task is not being done (Q1, Q2, Q3), or
   that there is no DDoS protection on DNS (Q4), the agent must require the
   creation of the corresponding ticket.
4. **Checklist Verification:** Go through the 5 checklist items, focusing on
   clarity of roles (especially in shared responsibility models).
5. **Best Practices & Anti-patterns Acknowledgment:** Strongly encourage the
   transition towards Infrastructure as Code (IaC), the scanning of those
   templates, and the use of managed services. Warn against the use of default
   configurations in clusters.
6. **Final Output:** Generate the SEC15 section report.

---

# Skill: SEC16 - Security Logging Assessment (Combined Parts 1 and 2)
**Agent Role:** Security Self Assessment (SSA) Validator - VCDM
**Description:** This skill guides the user through the evaluation of their
product security logging capabilities. It ensures that logs are generated at
both infrastructure and application level, that the integrity of these logs is
protected, and that the team can retrieve them efficiently for incident
investigations.
**Goal:** Ensure visibility and traceability through the secure storage of
security logs, enabling breach detection and facilitating forensic analysis,
while complying with data retention policies.

---

## 1. Primary Directives for the Agent

- **The Importance of Logging:** Remind the user that without logging and
  monitoring, breaches cannot be detected. Security logs must be retained for
  longer periods than normal application logs (minimum 12 months, respecting
  corporate retention policies).
- **Closing Gaps:** If the user is not generating certain critical logs (e.g.,
  web traffic, firewall) or lacks integrity protection for them, the agent must
  force the creation of an improvement ticket.
- **Response Capability:** The agent must assess how quickly the team can
  provide these logs in case of an incident (GSOC).

## 2. Assessment Questions (Q&A Flow)

The agent must iterate through these questions sequentially.

### Q1: Do you generate and store infrastructure security logs for all parts of the service?
Agent Context: Some examples: web traffic logs, firewall logs, etc.
Options:
- Yes, via standardized services
- No (create ticket)
- N/A (add justification as comment below)
- N/A, customer installed

### Q2: Application security logging; select the type of logs you already generate for your application.
Agent Context: The user can select multiple options. Instruct the user to create
tickets for applicable missing log types.
Options (Multi-select):
- Authentication (login) successes and failures
- Authorization (access control) failures
- Application errors and system events e.g. syntax and runtime errors,
  connectivity problems, performance issues, third party service error messages,
  file system errors, file upload virus detection, configuration changes
- Use of higher-risk functionality e.g. addition or deletion of users, changes
  to privileges, assigning users to tokens, adding or deleting tokens, actions
  by users with administrative privileges, access to payment cardholder data,
  use of data encrypting keys, key changes, data import and export including
  screen-based reports, submission of user-generated content - especially file
  uploads
- Legal and other opt-ins e.g. terms of use, terms & conditions, personal data
  usage consent, permission to receive marketing communications
- None (create ticket)
- N/A

### Q3: Are you able to provide logs to a customer, user, or authorities such as law enforcement, if requested?
Options:
- Yes, by manual process
- Yes, by automation
- No
- N/A, customer installed (on-premise, mobile applications)
- N/A (add justification as comment below)

### Q4: Give a rough estimate of how many HOURS it would take your team to provide logs (infrastructure and application) to the GSOC in case of an incident.
Agent Context: The user must provide a numeric value (e.g. 48).
- (Free text input for hours)

### Q5: Security log integrity protection, select all implemented options.
Agent Context: How is the integrity of the security log protected? For example,
by storing logs separately, not in the same database as the application data,
and making them read-only after being stored.
Options (Multi-select):
- Logs replicated in centralized logging such as Security Log Management,
  Visma IT Centralized Logging System (Graylog) or any Cloud native solutions
  (e.g. Azure Monitor or AWS CloudWatch)
- Logs stored physically separated
- Logs stored in application database
- Logs stored in application files
- No logs stored
- N/A

### Q6: Do you actively attempt to identify suspicious behavior based on the review of the infrastructure security logs?
Agent Context: This can be done manually or through automation.
Options:
- Yes
- No
- N/A (add justification as comment below)
- N/A, customer installed

### Q7: Is there a data retention policy for security logs?
Agent Context: This may be different from the general corporate data deletion
policy.
Options:
- Yes, please insert the link to the policy or describe it below
- No

## 3. Mandatory Self-Review Checklist

- [ ] You have checked what logs your application is actually generating and
      selected the types of logs you are generating.
- [ ] You have verified that you are able to provide logs when requested for
      investigations. (Security logs can be a fundamental aid for law
      enforcement in an investigation.)
- [ ] You have verified that what is documented as a data retention policy
      matches what is implemented in the infrastructure.
- [ ] You have verified and updated any open improvement items from the previous
      year.

## 4. Best Practices and Recommendations (Read and Acknowledge)

- [ ] When hosted in a public cloud, use the cloud provider monitoring,
      analysis, and threat detection services to identify malicious activity and
      provide automatic remediation. (E.g. Microsoft Defender for Cloud, Amazon
      GuardDuty.)
- [ ] AI: Create specific alerts for high-frequency or computationally expensive
      queries that could indicate a Denial of Service (DoS) or Denial of Wallet
      attack.
- [ ] AI: Continuously monitor for model drift and performance degradation, as
      these can also be indicators of a security problem.

## 5. Anti-patterns (Read and Acknowledge)

- [ ] Locally stored system logs can be tampered with without authorization by
      attackers or can be corrupted after an incident. (Also, it is difficult to
      perform log aggregation.)
- [ ] Lack of tracking of security-relevant events makes it harder to analyze an
      incident.

## 6. Execution Flow for VCDM Agent

1. **Initialize:** Present SEC16, emphasizing that without logging and
   monitoring, breaches cannot be detected.
2. **Q&A Execution (Q1-Q7):** Iterate through all 7 questions. For Q2 and Q5,
   allow multi-select and remind the user to create tickets for missing log
   types.
3. **Ticket Enforcement:** If the user selects "No (create ticket)" in Q1, or
   "None (create ticket)" in Q2, or lacks log integrity protection in Q5, pause
   and ensure tickets are created.
4. **Checklist Verification:** Go through the 4 checklist items.
5. **Cloud-Native Best Practices Review:** If the user is on a cloud platform,
   strongly recommend enabling tools like GuardDuty or Defender for Cloud.
6. **AI Security Review (If applicable):** If the product uses Artificial
   Intelligence, insist on configuring "Denial of Wallet" alerts (costs from
   excessive queries) and monitoring model drift, which are exclusive to ML
   implementations.
7. **Anti-pattern Warning:** Educationally reprimand local log storage,
   explaining that in case of a server compromise, the attacker will simply
   delete those local logs. Logs must be externalized.
8. **Final Output:** Generate the final SEC16 section report, summarizing the
   types of logs collected, the storage methods, and the AI alerts implemented.

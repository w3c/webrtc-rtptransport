# Security questionnaire in advance of W3C review  - https://www.w3.org/TR/security-privacy-questionnaire/

01.  What information might this feature expose to Web sites or other parties,
     and for what purposes is that exposure necessary?

    - This feature allows web developers to send and receive packets using the
      RTP/RTCP protocol defined in RFC 3550. This feature exposes the network
      condition and error information to some extent.

02.  Do features in your specification expose the minimum amount of information
     necessary to enable their intended uses?

03.  How do the features in your specification deal with personal information,
     personally-identifiable information (PII), or information derived from
     them?

    - This feature doesn't deal with such sensitive information.

04.  How do the features in your specification deal with sensitive information?

    - This feature doesn't deal with such sensitive information.

05.  Do the features in your specification introduce new state for an origin
     that persists across browsing sessions?

    - No. Also RtpTransport doesn't interact with cookies and other persistent
      state.

06.  Do the features in your specification expose information about the
     underlying platform to origins?

    - No.

07.  Does this specification allow an origin to send data to the underlying
     platform?

    - Yes, the feature uses network interfaces and can connect to localhost
      if a cooperating server is running.

08.  Do features in this specification enable access to device sensors?

    - No.

09.  What data do the features in this specification expose to an origin? Please
     also document what data is identical to data exposed by other features, in the
     same or different contexts.

    - Arbitrary data sent from a peer.
    - Network errors (mostly opaque).
    - Network information (indirectly).

10.  Do features in this specification enable new script execution/loading
     mechanisms?

    - No.

11.  Do features in this specification allow an origin to access other devices?

    - Yes, via the network.

12.  Do features in this specification allow an origin some measure of control over
     a user agent's native UI?

    - No.

13.  What temporary identifiers do the features in this specification create or
     expose to the web?

14.  How does this specification distinguish between behavior in first-party and
     third-party contexts?

15.  How do the features in this specification work in the context of a browser’s
     Private Browsing or Incognito mode?

    - The feature doesn't interact with cookies, HTTP cache and authentication,
      hence the feature works as usual in such a mode.

16.  Does this specification have both "Security Considerations" and "Privacy
     Considerations" sections?

    - Yes.

17.  Do features in your specification enable origins to downgrade default
     security protections?

    - Yes.

18.  What should this questionnaire have asked?

    - The questions seem adequate.
